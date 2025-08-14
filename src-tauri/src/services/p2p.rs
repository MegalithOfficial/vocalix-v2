use crate::state::{AppState, AppStateWithChannel, ConnectionState, Message, SessionKeys};
use p256::ecdh::EphemeralSecret;
use ring::aead;
use std::sync::Arc;
use tauri::{Emitter, Manager, Window};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, Mutex};

use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use serde_json::{json, Value};

pub async fn handle_connection(
    mut stream: TcpStream,
    window: Window,
    state: AppState,
    mut confirmation_rx: broadcast::Receiver<bool>,
    message_tx: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
    is_initiator: bool,
) {
    let role = if is_initiator { "INITIATOR" } else { "LISTENER" };
    log_and_emit(&window, role, "CONNECTION_START", "Starting secure connection handler").await;

    let my_identity = match state.device_identity.lock().await.clone() {
        Some(id) => id,
        None => {
            window.emit("ERROR", "No device identity loaded").ok();
            return;
        }
    };
    let my_public_key_bytes = my_identity.verifying_key().to_sec1_bytes().into_vec();
    let my_pub_key_hex = hex::encode(&my_public_key_bytes);
    log_and_emit(
        &window,
        role,
        "IDENTITY_LOADED",
        &format!("My public key: {}...", &my_pub_key_hex[..16]),
    )
    .await;

    {
        let mut kp = state.known_peers.lock().await;
        if kp.is_empty() {
            if let Ok(loaded) = crate::services::pairing::load_known_peers() {
                *kp = loaded;
            }
        }
    }

    let mut connection_state = ConnectionState::Authenticating;
    update_shared_connection_state(&window, Some(connection_state.clone())).await;

    log_and_emit(
        &window,
        role,
        "PROTOCOL_START",
        if is_initiator { "Sending Hello message" } else { "Waiting for Hello message" },
    )
    .await;

    let mut temp_dh_private_key: Option<EphemeralSecret> = None;
    let mut session_keys: Option<SessionKeys> = None;

    let mut local_confirmed = false;
    let mut peer_confirmed = false;

    let mut sent_initial_dh = false;
    let mut sent_response_dh = false;

    let mut peer_pubkey_hex_cache: Option<String> = None;
    let mut is_known_peer = false;

    let mut peer_device_pk_bytes: Option<Vec<u8>> = None;

    let (tx, mut rx) = mpsc::unbounded_channel();
    {
        let mut guard = message_tx.lock().await;
        *guard = Some(tx);
    }

    if is_initiator {
        send_message(&mut stream, &Message::Hello(my_public_key_bytes.clone())).await;
    }

    let mut last_activity = std::time::Instant::now();

    loop {
        tokio::select! {
            result = read_framed(&mut stream) => {
                let bytes = match result {
                    Ok(Some(b)) => { last_activity = std::time::Instant::now(); b },
                    Ok(None) => {
                        log_and_emit(&window, role, "CONNECTION_CLOSED", "Peer closed connection").await;
                        clear_shared_connection_state(&window).await;
                        break;
                    }
                    Err(e) => {
                        log_and_emit(&window, role, "READ_ERROR", &format!("Failed to read: {}", e)).await;
                        clear_shared_connection_state(&window).await;
                        break;
                    }
                };

                let received_msg: Message = match serde_json::from_slice(&bytes) {
                    Ok(m) => m,
                    Err(e) => {
                        log_and_emit(&window, role, "DECODE_ERROR", &format!("json decode: {}", e)).await;
                        continue;
                    }
                };

                log_and_emit(&window, role, "MESSAGE_RECEIVED", &format!("{:?}", &received_msg)).await;

                match (&connection_state, &received_msg) {
                    (ConnectionState::Authenticating, Message::Hello(peer_key)) => {
                        let peer_hex = hex::encode(peer_key);
                        peer_pubkey_hex_cache = Some(peer_hex.clone());
                        peer_device_pk_bytes = Some(peer_key.clone());

                        is_known_peer = {
                            let kp = state.known_peers.lock().await;
                            kp.contains_key(&peer_hex)
                        };
                        log_and_emit(&window, role, "HELLO_RECEIVED", &format!("From peer: {}...", &peer_hex[..16])).await;

                        if is_known_peer {
                            log_and_emit(&window, role, "AUTO_CONFIRM", "Known peer: auto-sending PairingConfirmed").await;
                            if !local_confirmed {
                                local_confirmed = true;
                                send_message(&mut stream, &Message::PairingConfirmed).await;
                            }
                            let (nonce, listener_pub_key) = crate::services::pairing::create_challenge();
                            send_message(&mut stream, &Message::Challenge { nonce, listener_pub_key }).await;
                        } else {
                            log_and_emit(&window, role, "NEW_PEER", "Unknown peer, starting DH key exchange").await;
                            let (privkey, pubkey_bytes) = crate::services::pairing::perform_initial_dh();
                            temp_dh_private_key = Some(privkey);
                            send_message(&mut stream, &Message::InitialDhKey(pubkey_bytes)).await;
                            sent_initial_dh = true;

                            let (nonce, listener_pub_key) = crate::services::pairing::create_challenge();
                            send_message(&mut stream, &Message::Challenge { nonce, listener_pub_key }).await;
                        }
                    }

                    (ConnectionState::Authenticating, Message::Challenge { nonce, listener_pub_key })
                    | (ConnectionState::WaitingForUserConfirmation, Message::Challenge { nonce, listener_pub_key })
                    | (ConnectionState::WaitingForPeerConfirmation, Message::Challenge { nonce, listener_pub_key }) => {
                        if peer_pubkey_hex_cache.is_none() {
                            let hex_pk = hex::encode(listener_pub_key);
                            peer_pubkey_hex_cache = Some(hex_pk.clone());
                            if state.known_peers.lock().await.contains_key(&hex_pk) && !is_known_peer {
                                is_known_peer = true;
                                if is_initiator && !local_confirmed {
                                    local_confirmed = true;
                                    send_message(&mut stream, &Message::PairingConfirmed).await;
                                    log_and_emit(&window, role, "AUTO_CONFIRM", "Known peer (from Challenge): auto-sent PairingConfirmed").await;
                                }
                            }
                        }

                        let sig = crate::services::pairing::create_challenge_signature(&state, nonce, listener_pub_key);
                        send_message(&mut stream, &Message::ChallengeResponse(sig)).await;

                        if !is_known_peer && !sent_initial_dh && !sent_response_dh {
                            let (privkey, pubkey_bytes) = crate::services::pairing::perform_initial_dh();
                            temp_dh_private_key = Some(privkey);
                            send_message(&mut stream, &Message::InitialDhKey(pubkey_bytes)).await;
                            sent_initial_dh = true;
                            log_and_emit(&window, role, "DH_KEY_SENT", "Sent initial DH public key (after Challenge)").await;
                        }

                        if is_initiator && local_confirmed && peer_confirmed {
                            log_and_emit(&window, role, "POST_PAIRING_SESSION_REQUEST", "Both confirmed; starting session ECDH").await;
                            let (session_priv, my_session_pub) = crate::services::pairing::perform_dh_exchange();
                            temp_dh_private_key = Some(session_priv);
                            send_message(&mut stream, &Message::SessionKeyRequest(my_session_pub.to_sec1_bytes().into_vec())).await;

                            connection_state = ConnectionState::Authenticating;
                            update_shared_connection_state(&window, Some(connection_state.clone())).await;
                        }
                    }

                    (ConnectionState::Authenticating, Message::ChallengeResponse(signature))
                    | (ConnectionState::WaitingForUserConfirmation, Message::ChallengeResponse(signature))
                    | (ConnectionState::WaitingForPeerConfirmation, Message::ChallengeResponse(signature)) => {
                        if let Some(ref peer_pk) = peer_device_pk_bytes {
                            if crate::services::pairing::verify_challenge_signature(peer_pk, &my_public_key_bytes, signature) {
                                log_and_emit(&window, role, "CHALLENGE_OK", "Challenge verified").await;
                            } else {
                                log_and_emit(&window, role, "CHALLENGE_FAIL", "Challenge verification failed").await;
                                window.emit("ERROR", "Challenge verification failed").ok();
                                break;
                            }
                        } else {
                            log_and_emit(&window, role, "CHALLENGE_FAIL", "No peer device key cached (Hello missing)").await;
                            window.emit("ERROR", "Protocol error: no peer identity").ok();
                            break;
                        }
                    }

                    (ConnectionState::Authenticating, Message::InitialDhKey(peer_dh_key_bytes))
                    | (ConnectionState::WaitingForUserConfirmation, Message::InitialDhKey(peer_dh_key_bytes)) => {
                        match p256::PublicKey::from_sec1_bytes(peer_dh_key_bytes) {
                            Ok(peer_public_key) => {
                                if !is_known_peer {
                                    let (privkey, my_eph_pub_bytes) = crate::services::pairing::perform_initial_dh();
                                    temp_dh_private_key = Some(privkey);
                                    send_message(&mut stream, &Message::ResponseDhKey(my_eph_pub_bytes)).await;
                                    sent_response_dh = true;

                                    let code = crate::services::pairing::generate_pairing_code(&peer_public_key);
                                    window.emit("PAIRING_REQUIRED", code).ok();
                                    log_and_emit(&window, role, "PAIRING_CODE_SHOWN", "Waiting for user confirmation...").await;

                                    connection_state = ConnectionState::WaitingForUserConfirmation;
                                    update_shared_connection_state(&window, Some(connection_state.clone())).await;
                                }
                            }
                            Err(e) => log_and_emit(&window, role, "INITIAL_DH_PARSE_ERROR", &format!("Invalid peer DH key: {}", e)).await,
                        }
                    }

                    (ConnectionState::Authenticating, Message::ResponseDhKey(peer_dh_key_bytes))
                    | (ConnectionState::WaitingForUserConfirmation, Message::ResponseDhKey(peer_dh_key_bytes)) => {
                        match p256::PublicKey::from_sec1_bytes(peer_dh_key_bytes) {
                            Ok(peer_public_key) => {
                                let code = crate::services::pairing::generate_pairing_code(&peer_public_key);
                                window.emit("PAIRING_REQUIRED", code).ok();
                                log_and_emit(&window, role, "PAIRING_CODE_SHOWN", "Waiting for user confirmation...").await;

                                connection_state = ConnectionState::WaitingForUserConfirmation;
                                update_shared_connection_state(&window, Some(connection_state.clone())).await;
                            }
                            Err(e) => log_and_emit(&window, role, "RESP_DH_PARSE_ERROR", &format!("Invalid response DH key: {}", e)).await,
                        }
                    }

                    (ConnectionState::WaitingForUserConfirmation, Message::PairingConfirmed)
                    | (ConnectionState::Authenticating, Message::PairingConfirmed)
                    | (ConnectionState::WaitingForPeerConfirmation, Message::PairingConfirmed) => {
                        if !peer_confirmed {
                            peer_confirmed = true;
                            log_and_emit(&window, role, "PEER_CONFIRMED", "Peer has confirmed pairing").await;

                            if local_confirmed && is_initiator {
                                log_and_emit(&window, role, "POST_PAIRING_SESSION_REQUEST", "Requesting session keys after both confirmed").await;
                                let (session_priv, my_session_pub) = crate::services::pairing::perform_dh_exchange();
                                temp_dh_private_key = Some(session_priv);
                                send_message(&mut stream, &Message::SessionKeyRequest(my_session_pub.to_sec1_bytes().into_vec())).await;

                                connection_state = ConnectionState::Authenticating;
                                update_shared_connection_state(&window, Some(connection_state.clone())).await;
                            }
                        } else {
                            log_and_emit(&window, role, "PEER_CONFIRMATION_IGNORED", "Duplicate peer confirmation ignored").await;
                        }
                    }

                    (ConnectionState::Authenticating, Message::SessionKeyRequest(session_pub_key))
                    | (ConnectionState::WaitingForUserConfirmation, Message::SessionKeyRequest(session_pub_key))
                    | (ConnectionState::WaitingForPeerConfirmation, Message::SessionKeyRequest(session_pub_key)) => {
                        log_and_emit(&window, role, "SESSION_KEY_REQUEST_RECEIVED", "Creating session keys from ephemeral DH").await;
                        let (session_priv, my_session_pub) = crate::services::pairing::perform_dh_exchange();
                        match crate::services::pairing::create_session_keys(&session_priv, session_pub_key) {
                            Ok((enc, dec, np_send, np_recv, session_id, kc_send, kc_recv)) => {
                                session_keys = Some(SessionKeys {
                                    encryption_key: enc,
                                    decryption_key: dec,
                                    send_nonce: Arc::new(Mutex::new(0)),
                                    recv_nonce: Arc::new(Mutex::new(None)),
                                    session_id,
                                    nonce_prefix_send: np_send,
                                    nonce_prefix_recv: np_recv,
                                    confirm_send_tag: kc_send,
                                    confirm_recv_tag: kc_recv,
                                });
                                send_message(&mut stream, &Message::SessionKeyResponse(my_session_pub.to_sec1_bytes().into_vec())).await;

                                if let Some(ref keys) = session_keys {
                                    send_message(&mut stream, &Message::KeyConfirm(keys.confirm_send_tag.to_vec())).await;
                                    log_and_emit(&window, role, "KEY_CONFIRM_SENT", "Sent key confirmation tag").await;
                                    window.emit("SUCCESS", "Session keys established. Awaiting key confirmation...").ok();
                                }

                                connection_state = ConnectionState::WaitingForPeerConfirmation;
                                update_shared_connection_state(&window, Some(connection_state.clone())).await;
                            }
                            Err(e) => {
                                log_and_emit(&window, role, "SESSION_KEY_ERROR", &format!("Failed to create session keys: {}", e)).await;
                                window.emit("ERROR", format!("Failed to create session keys: {}", e)).ok();
                                break;
                            }
                        }
                    }

                    (ConnectionState::Authenticating, Message::SessionKeyResponse(session_pub_key))
                    | (ConnectionState::WaitingForUserConfirmation, Message::SessionKeyResponse(session_pub_key))
                    | (ConnectionState::WaitingForPeerConfirmation, Message::SessionKeyResponse(session_pub_key)) => {
                        if let Some(session_priv) = temp_dh_private_key.take() {
                            match crate::services::pairing::create_session_keys(&session_priv, session_pub_key) {
                                Ok((enc, dec, np_send, np_recv, session_id, kc_send, kc_recv)) => {
                                    session_keys = Some(SessionKeys {
                                        encryption_key: enc,
                                        decryption_key: dec,
                                        send_nonce: Arc::new(Mutex::new(0)),
                                        recv_nonce: Arc::new(Mutex::new(None)),
                                        session_id,
                                        nonce_prefix_send: np_send,
                                        nonce_prefix_recv: np_recv,
                                        confirm_send_tag: kc_send,
                                        confirm_recv_tag: kc_recv,
                                    });

                                    if let Some(ref keys) = session_keys {
                                        send_message(&mut stream, &Message::KeyConfirm(keys.confirm_send_tag.to_vec())).await;
                                        log_and_emit(&window, role, "KEY_CONFIRM_SENT", "Sent key confirmation tag").await;
                                    }

                                    connection_state = ConnectionState::WaitingForPeerConfirmation;
                                    update_shared_connection_state(&window, Some(connection_state.clone())).await;
                                }
                                Err(e) => {
                                    log_and_emit(&window, role, "SESSION_KEY_ERROR", &format!("Failed to create session keys: {}", e)).await;
                                    window.emit("ERROR", format!("Failed to create session keys: {}", e)).ok();
                                    break;
                                }
                            }
                        }
                    }

                    (ConnectionState::Authenticating, Message::KeyConfirm(tag))
                    | (ConnectionState::WaitingForUserConfirmation, Message::KeyConfirm(tag))
                    | (ConnectionState::WaitingForPeerConfirmation, Message::KeyConfirm(tag)) => {
                        if let Some(ref keys) = session_keys {
                            if tag.as_slice() == &keys.confirm_recv_tag {
                                log_and_emit(&window, role, "KEY_CONFIRM_OK", "Peer confirmation tag verified").await;

                                if let Some(hex_pk) = &peer_pubkey_hex_cache {
                                    if !is_known_peer {
                                        let mut kp = state.known_peers.lock().await;
                                        if !kp.contains_key(hex_pk) {
                                            kp.insert(hex_pk.clone(), Vec::new());
                                            if let Err(e) = crate::services::pairing::save_known_peers(&kp) {
                                                eprintln!("[PEER_SAVE] failed: {}", e);
                                            } else {
                                                log_and_emit(&window, role, "PEER_SAVED", &format!("Saved trusted peer {}", &hex_pk[..16])).await;
                                            }
                                        }
                                        is_known_peer = true;
                                    }
                                }

                                connection_state = ConnectionState::Encrypted;
                                update_shared_connection_state(&window, Some(connection_state.clone())).await;
                                window.emit("SUCCESS", "Secure encrypted channel established!").ok();
                            } else {
                                log_and_emit(&window, role, "KEY_CONFIRM_FAIL", "Confirmation tag mismatch").await;
                                window.emit("ERROR", "Key confirmation failed").ok();
                                break;
                            }
                        }
                    }

                    (ConnectionState::Encrypted, Message::EncryptedMessage { ciphertext, nonce }) => {
                        if let Some(ref keys) = session_keys {
                            match decrypt_message(keys, ciphertext, nonce).await {
                                Ok(plaintext) => {
                                    handle_decrypted(&window, plaintext).await;
                                }
                                Err(e) => {
                                    log_and_emit(&window, role, "DECRYPT_FAIL", &format!("Decryption failed: {}", e)).await;
                                    window.emit("ERROR", format!("Decrypt error: {}", e)).ok();
                                    break;
                                }
                            }
                        }
                    }

                    (_, Message::Disconnect { reason }) => {
                        log_and_emit(&window, role, "DISCONNECT", &format!("Peer requested disconnect: {}", reason)).await;
                        break;
                    }

                    (_, _) => {
                        log_and_emit(&window, role, "IGNORED", &format!("State {:?} ignored message", connection_state)).await;
                    }
                }
            }

            // --- UI / APP MESSAGES (kept feature-complete) ---
            msg = rx.recv() => {
                if let Some(message) = msg {
                    log_and_emit(&window, role, "UI_MESSAGE_REQUEST", &format!("UI wants to send: {}", message)).await;

                    match connection_state {
                        ConnectionState::Encrypted => {
                            // 1) UI "Message" JSON'ı gönderiyorsa ayrıştır
                            if let Ok(parsed) = serde_json::from_str::<Message>(&message) {
                                match parsed {
                                    Message::Disconnect { .. } => {
                                        send_message(&mut stream, &parsed).await;
                                    }
                                    Message::RedemptionMessage { audio, title, content, message_type, time } => {
                                        send_redemption_message(
                                            &mut stream,
                                            &session_keys,
                                            audio, title, content, message_type, time
                                        ).await;
                                    }
                                    other => {
                                        if let Some(ref keys) = session_keys {
                                            if let Ok(serialized) = serde_json::to_string(&other) {
                                                match encrypt_message(keys, &serialized).await {
                                                    Ok((ciphertext, nonce)) => {
                                                        send_message(&mut stream, &Message::EncryptedMessage { ciphertext, nonce }).await;
                                                        log_and_emit(&window, role, "UI_PAYLOAD_ENCRYPTED", "Generic message sent encrypted").await;
                                                    }
                                                    Err(e) => {
                                                        log_and_emit(&window, role, "ENCRYPT_FAIL", &format!("Generic: {}", e)).await;
                                                        window.emit("ERROR", format!("Encrypt error: {}", e)).ok();
                                                    }
                                                }
                                            }
                                        } else {
                                            window.emit("ERROR", "Cannot send: session not ready").ok();
                                        }
                                    }
                                }
                            } else {
                                if let Some(ref keys) = session_keys {
                                    let serialized = serde_json::to_string(&Message::PlaintextMessage(message.clone())).unwrap();
                                    match encrypt_message(keys, &serialized).await {
                                        Ok((ciphertext, nonce)) => {
                                            send_message(&mut stream, &Message::EncryptedMessage { ciphertext, nonce }).await;
                                            log_and_emit(&window, role, "UI_PAYLOAD_ENCRYPTED", "Raw string sent encrypted").await;
                                        }
                                        Err(e) => {
                                            log_and_emit(&window, role, "PLAINTEXT_ENCRYPT_FAIL", &format!("{}", e)).await;
                                            window.emit("ERROR", format!("Encrypt error: {}", e)).ok();
                                        }
                                    }
                                } else {
                                    window.emit("ERROR", "Cannot send: session not ready").ok();
                                }
                            }
                        }

                        _ => {
                            if let Ok(Message::Disconnect { reason }) = serde_json::from_str::<Message>(&message) {
                                send_message(&mut stream, &Message::Disconnect { reason }).await;
                            } else {
                                window.emit("ERROR", "Cannot send message: connection is not encrypted").ok();
                            }
                        }
                    }
                }
            }
        }

        while let Ok(confirmed) = confirmation_rx.try_recv() {
            if confirmed && !local_confirmed {
                local_confirmed = true;
                log_and_emit(&window, role, "USER_CONFIRMATION", "User confirmed pairing").await;

                if peer_confirmed && is_initiator {
                    log_and_emit(&window, role, "POST_PAIRING_SESSION_REQUEST", "Requesting session keys after both confirmed").await;
                    let (session_priv, my_session_pub) = crate::services::pairing::perform_dh_exchange();
                    temp_dh_private_key = Some(session_priv);
                    send_message(&mut stream, &Message::SessionKeyRequest(my_session_pub.to_sec1_bytes().into_vec())).await;

                    connection_state = ConnectionState::Authenticating;
                    update_shared_connection_state(&window, Some(connection_state.clone())).await;
                }
            } else {
                log_and_emit(&window, role, "CONFIRMATION_IGNORED", "Duplicate local confirmation ignored").await;
            }
        }

        if last_activity.elapsed().as_secs() > 300 {
            log_and_emit(&window, role, "CONNECTION_TIMEOUT", "Connection timed out due to inactivity").await;
            break;
        }
    }

    {
        let mut guard = message_tx.lock().await;
        *guard = None;
    }
    log_and_emit(&window, role, "CONNECTION_ENDED", "Connection loop ended, cleaning up").await;
    clear_shared_connection_state(&window).await;
}

async fn handle_decrypted(window: &Window, plaintext: String) {
    if let Ok(msg) = serde_json::from_str::<crate::state::Message>(&plaintext) {
        match msg {
            crate::state::Message::RedemptionMessage { audio, title, content, message_type: _, time } => {
                let payload = json!({
                    "id": format!("redemption_{}", Utc::now().timestamp_millis()),
                    "title": title,
                    "content": content,
                    "timerDuration": time,
                    "audioData": general_purpose::STANDARD.encode(&audio)
                });
                let _ = window.emit("REDEMPTION_RECEIVED", payload);
                return;
            }
            crate::state::Message::PlaintextMessage(s) => {
                let _ = window.emit("PLAINTEXT", s);
                return;
            }
            _ => { }
        }
    }

    let v: Value = match serde_json::from_str(&plaintext) {
        Ok(v) => v,
        Err(_) => {
            let _ = window.emit("PLAINTEXT", plaintext);
            return;
        }
    };
    let _ = window.emit("PLAINTEXT", v);
}

async fn encrypt_message(keys: &SessionKeys, plaintext: &str) -> Result<(Vec<u8>, [u8; 12]), String> {
    // seq
    let seq = {
        let mut s = keys.send_nonce.lock().await;
        let v = *s;
        *s = v + 1;
        v
    };
    let mut nonce = [0u8; 12];
    nonce[..4].copy_from_slice(&keys.nonce_prefix_send);
    nonce[4..].copy_from_slice(&seq.to_be_bytes());

    // AAD
    let mut aad = Vec::with_capacity(11 + 16 + 8);
    aad.extend_from_slice(b"vocalix v2");
    aad.extend_from_slice(&keys.session_id);
    aad.extend_from_slice(&seq.to_be_bytes());

    let aead_nonce = aead::Nonce::assume_unique_for_key(nonce);
    let mut in_out = plaintext.as_bytes().to_vec();
    let tag = keys
        .encryption_key
        .seal_in_place_separate_tag(aead_nonce, aead::Aad::from(&aad), &mut in_out)
        .map_err(|_| "Encryption failed".to_string())?;
    in_out.extend_from_slice(tag.as_ref());
    Ok((in_out, nonce))
}

async fn decrypt_message(keys: &SessionKeys, ciphertext: &[u8], nonce: &[u8; 12]) -> Result<String, String> {
    if nonce[..4] != keys.nonce_prefix_recv { return Err("Invalid nonce prefix".into()); }

    let mut seq_bytes = [0u8; 8];
    seq_bytes.copy_from_slice(&nonce[4..]);
    let incoming_seq = u64::from_be_bytes(seq_bytes);

    {
        let mut last = keys.recv_nonce.lock().await;
        if let Some(prev) = *last {
            if incoming_seq <= prev {
                return Err("Replay detected".into());
            }
        }
        *last = Some(incoming_seq);
    }

    let mut aad = Vec::with_capacity(11 + 16 + 8);
    aad.extend_from_slice(b"vocalix v2");
    aad.extend_from_slice(&keys.session_id);
    aad.extend_from_slice(&incoming_seq.to_be_bytes());

    let aead_nonce = aead::Nonce::assume_unique_for_key(*nonce);
    let mut in_out = ciphertext.to_vec();
    let plaintext_bytes = keys
        .decryption_key
        .open_in_place(aead_nonce, aead::Aad::from(&aad), &mut in_out)
        .map_err(|_| "Decryption failed".to_string())?;
    String::from_utf8(plaintext_bytes.to_vec()).map_err(|_| "Invalid UTF-8".to_string())
}

async fn read_framed(stream: &mut TcpStream) -> tokio::io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    match stream.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len_buf) as usize;
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

async fn send_message(stream: &mut TcpStream, msg: &Message) {
    match serde_json::to_vec(msg) {
        Ok(bytes) => {
            let len = (bytes.len() as u32).to_be_bytes();
            if let Err(e) = stream.write_all(&len).await { eprintln!("[SEND] len write error: {}", e); }
            if let Err(e) = stream.write_all(&bytes).await { eprintln!("[SEND] bytes write error: {}", e); }
            let _ = stream.flush().await;
        }
        Err(e) => eprintln!("[SEND_ERROR] Failed to serialize message: {}", e),
    }
}

async fn log_and_emit(window: &Window, role: &str, event: &str, details: &str) {
    let log_msg = format!("[{}] {}: {}", role, event, details);
    println!("{}", log_msg);
    let _ = window.emit("PROTOCOL_LOG", log_msg);
}

async fn update_shared_connection_state(window: &Window, new_state: Option<ConnectionState>) {
    if let Some(app_state_with_channel) = window.app_handle().try_state::<AppStateWithChannel>() {
        let mut lock = app_state_with_channel.connection_state.lock().await;
        *lock = new_state;
    }
}

async fn clear_shared_connection_state(window: &Window) {
    update_shared_connection_state(window, None).await;
}

async fn send_redemption_message(
    stream: &mut TcpStream,
    session_keys: &Option<SessionKeys>,
    audio: Vec<u8>,
    title: String,
    content: String,
    message_type: u8,
    time: Option<u32>,
) {
    if let Some(keys) = session_keys {
        let redemption_msg = Message::RedemptionMessage { audio, title, content, message_type, time };
        match serde_json::to_string(&redemption_msg) {
            Ok(serialized) => match encrypt_message(keys, &serialized).await {
                Ok((ciphertext, nonce)) => {
                    let msg = Message::EncryptedMessage { ciphertext, nonce };
                    send_message(stream, &msg).await;
                }
                Err(e) => eprintln!("[REDEMPTION_ERROR] Failed to encrypt redemption message: {}", e),
            },
            Err(e) => eprintln!("[REDEMPTION_ERROR] Failed to serialize redemption message: {}", e),
        }
    }
}