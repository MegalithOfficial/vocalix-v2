use crate::state::{AppState, AppStateWithChannel, ConnectionState, Message, SessionKeys};
use p256::ecdh::EphemeralSecret;
use ring::aead;
use std::sync::Arc;
use tauri::{Emitter, Window, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, Mutex};

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

    let my_identity = state.device_identity.lock().await.clone().unwrap();
    let my_public_key_bytes = my_identity.verifying_key().to_sec1_bytes().into_vec();
    let my_pub_key_hex = hex::encode(&my_public_key_bytes);

    log_and_emit(
        &window,
        role,
        "IDENTITY_LOADED",
        &format!("My public key: {}...", &my_pub_key_hex[..16]),
    )
    .await;

    let mut connection_state = ConnectionState::Authenticating;
    update_shared_connection_state(&window, Some(connection_state.clone())).await;

    let mut peer_public_key_hex: Option<String> = None;
    let mut long_term_secret: Option<Vec<u8>> = None;
    let mut temp_dh_private_key: Option<EphemeralSecret> = None;
    let mut session_keys: Option<SessionKeys> = None;
    let mut challenge_nonce: Option<Vec<u8>> = None;

    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<String>();
    {
        let mut shared_tx = message_tx.lock().await;
        *shared_tx = Some(msg_tx);
    }

    if is_initiator {
        log_and_emit(&window, role, "PROTOCOL_START", "Sending Hello message").await;
        let msg = Message::Hello(my_public_key_bytes.clone());
        send_message(&mut stream, &msg).await;
    } else {
        log_and_emit(&window, role, "PROTOCOL_START", "Waiting for Hello message").await;
    }

    let mut buffer = vec![0; 8192];
    let mut line_buffer = Vec::new();
    let mut last_activity = std::time::Instant::now();
    let connection_timeout = std::time::Duration::from_secs(30); // 30 second timeout

    loop {
        tokio::select! {
            // Network data
            result = stream.read(&mut buffer) => {
                let n = match result {
                    Ok(0) => {
                        log_and_emit(&window, role, "CONNECTION_CLOSED", "Peer closed connection gracefully").await;
                        window.emit("STATUS_UPDATE", "Peer disconnected").ok();
                        window.emit("PEER_DISCONNECT", "Connection closed by peer").ok();
                        clear_shared_connection_state(&window).await;
                        break;
                    },
                    Ok(n) => {
                        last_activity = std::time::Instant::now(); // Update activity timestamp
                        n
                    },
                    Err(e) => {
                        log_and_emit(&window, role, "CONNECTION_ERROR", &format!("Network read error: {}", e)).await;
                        window.emit("ERROR", format!("Connection error: {}", e)).ok();
                        window.emit("PEER_DISCONNECT", format!("Connection lost: {}", e)).ok();
                        
                        // Try to send disconnect notice if possible
                        let _ = send_disconnect(&mut stream, &session_keys, &format!("Connection error: {}", e)).await;
                        
                        clear_shared_connection_state(&window).await;
                        break;
                    }
                };

                line_buffer.extend_from_slice(&buffer[..n]);

                while let Some(newline_pos) = line_buffer.iter().position(|&b| b == b'\n') {
                    let message_bytes = line_buffer.drain(..newline_pos + 1).collect::<Vec<u8>>();
                    let message_bytes = &message_bytes[..message_bytes.len()-1]; // remove '\n'
                    if message_bytes.is_empty() { continue; }

                    let received_msg: Message = match serde_json::from_slice(message_bytes) {
                        Ok(msg) => { log_and_emit(&window, role, "MESSAGE_RECEIVED", &format!("{:?}", msg)).await; msg },
                        Err(e) => {
                            let raw_data = String::from_utf8_lossy(message_bytes);
                            let error_details = format!(
                                "Failed to parse message: {}\nRaw data ({} bytes): {}\nHex: {}",
                                e, message_bytes.len(), raw_data, hex::encode(message_bytes)
                            );
                            log_and_emit(&window, role, "PARSE_ERROR", &error_details).await;
                            let _ = window.emit("ERROR", error_details);
                            continue;
                        }
                    };

                    match (&connection_state, &received_msg) {
                        // === AUTH PHASE ===
                        (ConnectionState::Authenticating, Message::Hello(peer_key)) => {
                            peer_public_key_hex = Some(hex::encode(peer_key));
                            let peer_key_short = &peer_public_key_hex.as_ref().unwrap()[..16];
                            log_and_emit(&window, role, "HELLO_RECEIVED", &format!("From peer: {}...", peer_key_short)).await;

                            let peers = state.known_peers.lock().await;
                            if let Some(secret) = peers.get(peer_public_key_hex.as_ref().unwrap()) {
                                long_term_secret = Some(secret.clone());
                                log_and_emit(&window, role, "KNOWN_PEER", "Peer found in database, sending challenge").await;
                                window.emit("STATUS_UPDATE", "Known peer found. Sending challenge...").unwrap();
                                let nonce: [u8;16] = rand::random();
                                challenge_nonce = Some(nonce.to_vec());
                                let msg = Message::Challenge { nonce: nonce.to_vec(), listener_pub_key: my_public_key_bytes.clone() };
                                log_and_emit(&window, role, "CHALLENGE_SENT", &format!("Challenge nonce: {}", hex::encode(&nonce))).await;
                                send_message(&mut stream, &msg).await;
                            } else {
                                log_and_emit(&window, role, "NEW_PEER", "Unknown peer, starting DH key exchange").await;
                                window.emit("STATUS_UPDATE", "New peer. Starting DH exchange...").unwrap();
                                let (priv_key, pub_key) = crate::services::pairing::perform_dh_exchange();
                                temp_dh_private_key = Some(priv_key);
                                let msg = Message::InitialDhKey(pub_key.to_sec1_bytes().into_vec());
                                log_and_emit(&window, role, "DH_KEY_SENT", "Sent initial DH public key").await;
                                send_message(&mut stream, &msg).await;
                            }
                        },
                        (ConnectionState::Authenticating, Message::Challenge { nonce, listener_pub_key }) => {
                            peer_public_key_hex = Some(hex::encode(listener_pub_key));
                            let peer_key_short = &peer_public_key_hex.as_ref().unwrap()[..16];
                            log_and_emit(&window, role, "CHALLENGE_RECEIVED", &format!("From peer: {}..., nonce: {}", peer_key_short, hex::encode(nonce))).await;

                            let peers = state.known_peers.lock().await;
                            if let Some(secret) = peers.get(peer_public_key_hex.as_ref().unwrap()) {
                                log_and_emit(&window, role, "CHALLENGE_PROCESSING", "Creating signature response").await;
                                window.emit("STATUS_UPDATE", "Challenge received. Responding...").unwrap();
                                let signature = crate::services::pairing::create_challenge_signature(secret, nonce);
                                let msg = Message::ChallengeResponse(signature.as_ref().to_vec());
                                log_and_emit(&window, role, "CHALLENGE_RESPONSE_SENT", &format!("Signature: {}", hex::encode(signature.as_ref()))).await;
                                send_message(&mut stream, &msg).await;
                                window.emit("STATUS_UPDATE", "Challenge sent. Waiting for session setup...").unwrap();
                            } else {
                                log_and_emit(&window, role, "CHALLENGE_ERROR", "Challenged by unknown peer").await;
                                window.emit("ERROR", "FATAL: Challenged by an unknown peer.").unwrap();
                                break;
                            }
                        },
                        (ConnectionState::Authenticating, Message::ChallengeResponse(signature)) => {
                            log_and_emit(&window, role, "CHALLENGE_RESPONSE_RECEIVED", &format!("Signature: {}", hex::encode(signature))).await;
                            if let (Some(secret), Some(nonce)) = (long_term_secret.as_ref(), challenge_nonce.as_ref()) {
                                if crate::services::pairing::verify_challenge_signature(secret, nonce, signature) {
                                    log_and_emit(&window, role, "AUTH_SUCCESS", "Challenge signature verified successfully").await;
                                    window.emit("STATUS_UPDATE", "Authentication successful! Setting up secure session...").unwrap();
                                    let (session_priv, session_pub) = crate::services::pairing::perform_dh_exchange();
                                    temp_dh_private_key = Some(session_priv);
                                    let msg = Message::SessionKeyRequest(session_pub.to_sec1_bytes().into_vec());
                                    log_and_emit(&window, role, "SESSION_KEY_REQUEST_SENT", "Requesting session key establishment").await;
                                    send_message(&mut stream, &msg).await;
                                } else {
                                    log_and_emit(&window, role, "AUTH_FAILED", "Challenge signature verification failed").await;
                                    window.emit("ERROR", "Authentication failed!").unwrap();
                                    break;
                                }
                            }
                        },
                        (ConnectionState::Authenticating, Message::InitialDhKey(peer_dh_key)) => {
                            window.emit("STATUS_UPDATE", "DH key received. Generating shared secret...").unwrap();
                            let (priv_key, pub_key) = crate::services::pairing::perform_dh_exchange();
                            let peer_public_key = p256::PublicKey::from_sec1_bytes(peer_dh_key).unwrap();
                            let shared_secret = priv_key.diffie_hellman(&peer_public_key);
                            long_term_secret = Some(shared_secret.raw_secret_bytes().to_vec());
                            let code = crate::services::pairing::generate_6_digit_code(long_term_secret.as_ref().unwrap());
                            window.emit("PAIRING_REQUIRED", code).unwrap();
                            temp_dh_private_key = Some(priv_key);
                            let msg = Message::ResponseDhKey(pub_key.to_sec1_bytes().into_vec());
                            send_message(&mut stream, &msg).await;
                            connection_state = ConnectionState::WaitingForUserConfirmation;
                        },
                        (ConnectionState::Authenticating, Message::ResponseDhKey(peer_dh_key)) => {
                            let peer_public_key = p256::PublicKey::from_sec1_bytes(peer_dh_key).unwrap();
                            let shared_secret = temp_dh_private_key.take().unwrap().diffie_hellman(&peer_public_key);
                            long_term_secret = Some(shared_secret.raw_secret_bytes().to_vec());
                            let code = crate::services::pairing::generate_6_digit_code(long_term_secret.as_ref().unwrap());
                            window.emit("PAIRING_REQUIRED", code).unwrap();
                            window.emit("STATUS_UPDATE", "Code displayed. Waiting for user confirmation...").unwrap();
                            connection_state = ConnectionState::WaitingForUserConfirmation;
                        },
                        (ConnectionState::WaitingForUserConfirmation, Message::PairingConfirmed) => {
                            log_and_emit(&window, role, "PEER_CONFIRMED", "Peer has confirmed pairing").await;
                            window.emit("STATUS_UPDATE", "Peer confirmed pairing. Setting up secure session...").unwrap();
                            let (session_priv, session_pub) = crate::services::pairing::perform_dh_exchange();
                            temp_dh_private_key = Some(session_priv);
                            let msg = Message::SessionKeyRequest(session_pub.to_sec1_bytes().into_vec());
                            log_and_emit(&window, role, "POST_PAIRING_SESSION_REQUEST", "Requesting session keys after both confirmed").await;
                            send_message(&mut stream, &msg).await;
                            connection_state = ConnectionState::Authenticating;
                        },
                        (ConnectionState::WaitingForPeerConfirmation, Message::PairingConfirmed) => {
                            log_and_emit(&window, role, "PEER_CONFIRMED", "Peer has confirmed pairing, ready for session keys").await;
                            window.emit("STATUS_UPDATE", "Both peers confirmed. Starting session setup...").unwrap();
                            // Now that both sides confirmed, start the session key exchange
                            let (session_priv, session_pub) = crate::services::pairing::perform_dh_exchange();
                            temp_dh_private_key = Some(session_priv);
                            let msg = Message::SessionKeyRequest(session_pub.to_sec1_bytes().into_vec());
                            log_and_emit(&window, role, "INITIATING_SESSION_KEYS", "Starting session key exchange after mutual confirmation").await;
                            send_message(&mut stream, &msg).await;
                            connection_state = ConnectionState::Authenticating;
                        },
                        // === SESSION KEY ESTABLISHMENT ===
                        (ConnectionState::Authenticating, Message::SessionKeyRequest(session_pub_key)) => {
                            log_and_emit(&window, role, "SESSION_KEY_REQUEST_RECEIVED", "Creating session keys from ephemeral DH").await;
                            window.emit("STATUS_UPDATE", "Creating session keys...").unwrap();
                            let (session_priv, my_session_pub) = crate::services::pairing::perform_dh_exchange();
                            match crate::services::pairing::create_session_keys(&session_priv, session_pub_key) {
                                Ok((decryption_key, encryption_key)) => {
                                    log_and_emit(&window, role, "SESSION_KEYS_CREATED", "Session encryption keys established").await;
                                    session_keys = Some(SessionKeys { encryption_key, decryption_key, send_nonce: Arc::new(Mutex::new(0)), recv_nonce: Arc::new(Mutex::new(0)), });
                                    let msg = Message::SessionKeyResponse(my_session_pub.to_sec1_bytes().into_vec());
                                    log_and_emit(&window, role, "SESSION_KEY_RESPONSE_SENT", "Sending session key response").await;
                                    send_message(&mut stream, &msg).await;
                                    let msg = Message::EncryptionReady;
                                    log_and_emit(&window, role, "ENCRYPTION_READY_SENT", "Signaling encryption ready").await;
                                    send_message(&mut stream, &msg).await;
                                    connection_state = ConnectionState::Encrypted;
                                    update_shared_connection_state(&window, Some(connection_state.clone())).await;
                                    log_and_emit(&window, role, "STATE_CHANGE", "Entering ENCRYPTED state").await;
                                    window.emit("SUCCESS", "Secure encrypted channel established!").unwrap();
                                },
                                Err(e) => {
                                    log_and_emit(&window, role, "SESSION_KEY_ERROR", &format!("Failed to create session keys: {}", e)).await;
                                    window.emit("ERROR", format!("Failed to create session keys: {}", e)).unwrap();
                                    break;
                                }
                            }
                        },
                        (ConnectionState::Authenticating, Message::SessionKeyResponse(session_pub_key)) => {
                            log_and_emit(&window, role, "SESSION_KEY_RESPONSE_RECEIVED", "Completing session key setup").await;
                            window.emit("STATUS_UPDATE", "Completing session key setup...").unwrap();
                            if let Some(session_priv) = temp_dh_private_key.take() {
                                match crate::services::pairing::create_session_keys(&session_priv, session_pub_key) {
                                    Ok((encryption_key, decryption_key)) => {
                                        log_and_emit(&window, role, "SESSION_KEYS_COMPLETED", "Session keys created, waiting for encryption ready").await;
                                        session_keys = Some(SessionKeys { encryption_key, decryption_key, send_nonce: Arc::new(Mutex::new(0)), recv_nonce: Arc::new(Mutex::new(0)), });
                                        window.emit("SUCCESS", "Session keys established! Waiting for encryption ready signal...").unwrap();
                                    },
                                    Err(e) => {
                                        log_and_emit(&window, role, "SESSION_KEY_ERROR", &format!("Failed to create session keys: {}", e)).await;
                                        window.emit("ERROR", format!("Failed to create session keys: {}", e)).unwrap();
                                        break;
                                    }
                                }
                            }
                        },
                        (ConnectionState::Authenticating, Message::EncryptionReady) => {
                            log_and_emit(&window, role, "ENCRYPTION_READY_RECEIVED", "Encryption ready signal received").await;
                            connection_state = ConnectionState::Encrypted;
                            update_shared_connection_state(&window, Some(connection_state.clone())).await;
                            log_and_emit(&window, role, "STATE_CHANGE", "Entering ENCRYPTED state").await;
                            window.emit("SUCCESS", "Secure encrypted channel established!").unwrap();
                        },
                        // === ENCRYPTED COMMUNICATION ===
                        (ConnectionState::Encrypted, Message::EncryptedMessage { ciphertext, nonce }) => {
                            log_and_emit(&window, role, "ENCRYPTED_MESSAGE_RECEIVED", &format!("Ciphertext size: {} bytes, nonce: {}", ciphertext.len(), hex::encode(nonce))).await;
                            if let Some(ref keys) = session_keys {
                                match decrypt_message(keys, ciphertext, nonce).await {
                                    Ok(plaintext) => {
                                        log_and_emit(&window, role, "MESSAGE_DECRYPTED", &format!("Plaintext: {}", plaintext)).await;
                                        if let Ok(protocol_msg) = serde_json::from_str::<Message>(&plaintext) {
                                            match protocol_msg {
                                                Message::RedemptionMessage { audio, title, content, message_type, time } => {
                                                    let protocol_type = match message_type { 1 => "redemption-with-timer", _ => "redemption-without-timer" };
                                                    log_and_emit(&window, role, "REDEMPTION_DECRYPTED", &format!("Type: {}, Title: {}, Audio: {} bytes", protocol_type, title, audio.len())).await;
                                                    let redemption_data = serde_json::json!({
                                                        "type": protocol_type,
                                                        "title": title,
                                                        "content": content,
                                                        "audio": audio,
                                                        "time": time
                                                    });
                                                    window.emit("REDEMPTION_RECEIVED", redemption_data).unwrap();
                                                },
                                                Message::Disconnect { reason } => {
                                                    log_and_emit(&window, role, "PEER_DISCONNECT", &format!("Peer sent graceful disconnect: {}", reason)).await;
                                                    window.emit("STATUS_UPDATE", format!("Peer disconnecting: {}", reason)).ok();
                                                    window.emit("PEER_DISCONNECT", format!("Peer disconnected: {}", reason)).ok();
                                                    
                                                    // Send acknowledgment back to confirm we received the disconnect
                                                    let ack_reason = format!("Disconnect acknowledged: {}", reason);
                                                    let _ = send_disconnect(&mut stream, &session_keys, &ack_reason).await;
                                                    
                                                    clear_shared_connection_state(&window).await;
                                                    // Exit handler – terminate loop & close socket
                                                    return;
                                                },
                                                _ => { window.emit("MESSAGE_RECEIVED", plaintext).unwrap(); }
                                            }
                                        } else {
                                            window.emit("MESSAGE_RECEIVED", plaintext).unwrap();
                                        }
                                    },
                                    Err(e) => {
                                        log_and_emit(&window, role, "DECRYPTION_ERROR", &format!("Failed to decrypt: {}", e)).await;
                                        window.emit("ERROR", format!("Failed to decrypt message: {}", e)).unwrap();
                                    }
                                }
                            }
                        },
                        // WaitingForPeerConfirmation may receive SessionKeyRequest directly
                        (ConnectionState::WaitingForPeerConfirmation, Message::SessionKeyRequest(session_pub_key)) => {
                            log_and_emit(&window, role, "SESSION_KEY_REQUEST_RECEIVED", "Creating session keys from ephemeral DH").await;
                            window.emit("STATUS_UPDATE", "Creating session keys...").unwrap();
                            let (session_priv, my_session_pub) = crate::services::pairing::perform_dh_exchange();
                            match crate::services::pairing::create_session_keys(&session_priv, session_pub_key) {
                                Ok((decryption_key, encryption_key)) => {
                                    log_and_emit(&window, role, "SESSION_KEYS_CREATED", "Session encryption keys established").await;
                                    session_keys = Some(SessionKeys { encryption_key, decryption_key, send_nonce: Arc::new(Mutex::new(0)), recv_nonce: Arc::new(Mutex::new(0)), });
                                    let msg = Message::SessionKeyResponse(my_session_pub.to_sec1_bytes().into_vec());
                                    log_and_emit(&window, role, "SESSION_KEY_RESPONSE_SENT", "Sending session key response").await;
                                    send_message(&mut stream, &msg).await;
                                    let msg = Message::EncryptionReady;
                                    log_and_emit(&window, role, "ENCRYPTION_READY_SENT", "Signaling encryption ready").await;
                                    send_message(&mut stream, &msg).await;
                                    connection_state = ConnectionState::Encrypted;
                                    update_shared_connection_state(&window, Some(connection_state.clone())).await;
                                    log_and_emit(&window, role, "STATE_CHANGE", "Entering ENCRYPTED state").await;
                                    window.emit("SUCCESS", "Secure encrypted channel established!").unwrap();
                                },
                                Err(e) => {
                                    log_and_emit(&window, role, "SESSION_KEY_ERROR", &format!("Failed to create session keys: {}", e)).await;
                                    window.emit("ERROR", format!("Failed to create session keys: {}", e)).unwrap();
                                    break;
                                }
                            }
                        },
                        _ => {
                            log_and_emit(&window, role, "UNEXPECTED_MESSAGE", &format!("Message: {:?} in state: {:?}", received_msg, connection_state)).await;
                            let _ = window.emit("ERROR", format!("Unexpected message {:?} in state {:?}", received_msg, connection_state));
                        }
                    }
                }
            },
            // User confirmation
            result = confirmation_rx.recv() => {
                if let Ok(true) = result {
                    log_and_emit(&window, role, "USER_CONFIRMATION", "User confirmed pairing").await;
                    match connection_state {
                        ConnectionState::WaitingForUserConfirmation => {
                            window.emit("STATUS_UPDATE", "Pairing confirmed by user!").unwrap();
                            if let (Some(key), Some(secret)) = (peer_public_key_hex.clone(), long_term_secret.clone()) {
                                let mut peers = state.known_peers.lock().await;
                                peers.insert(key.clone(), secret);
                                if let Err(e) = crate::services::pairing::save_known_peers(&peers) {
                                    log_and_emit(&window, role, "SAVE_PEER_ERROR", &format!("Failed to save peer: {}", e)).await;
                                    window.emit("ERROR", format!("Failed to save peer: {}", e)).unwrap();
                                } else {
                                    log_and_emit(&window, role, "PEER_SAVED", &format!("Saved new peer: {}...", &key[..16])).await;
                                    let msg = Message::PairingConfirmed;
                                    log_and_emit(&window, role, "PAIRING_CONFIRMED_SENT", "Sending pairing confirmation to peer").await;
                                    send_message(&mut stream, &msg).await;
                                    connection_state = ConnectionState::WaitingForPeerConfirmation;
                                    window.emit("SUCCESS", "Pairing confirmed! Waiting for peer confirmation...").unwrap();
                                }
                            }
                        },
                        _ => {
                            log_and_emit(&window, role, "CONFIRMATION_ERROR", "Unexpected confirmation in current state").await;
                            window.emit("ERROR", "Unexpected confirmation in current state").unwrap();
                        }
                    }
                }
            },
            // Outbound messages from UI
            msg = msg_rx.recv() => {
                if let Some(message) = msg {
                    log_and_emit(&window, role, "UI_MESSAGE_REQUEST", &format!("UI wants to send: {}", message)).await;
                    match connection_state {
                        ConnectionState::Encrypted => {
                            if let Ok(redemption_msg) = serde_json::from_str::<Message>(&message) {
                                match redemption_msg {
                                    Message::RedemptionMessage { audio, title, content, message_type, time } => {
                                        log_and_emit(&window, role, "SENDING_REDEMPTION", &format!("Type: {}, Title: {}, Audio: {} bytes", message_type, &title, audio.len())).await;
                                        let title_clone = title.clone();
                                        let content_clone = content.clone();
                                        send_redemption_message(&mut stream, &session_keys, audio, title, content, message_type, time).await;
                                        let protocol_type = if message_type == 1 { "redemption-with-timer" } else { "redemption-without-timer" };
                                        window.emit("REDEMPTION_SENT", serde_json::json!({
                                            "type": protocol_type,
                                            "title": title_clone,
                                            "content": content_clone,
                                            "time": time
                                        })).unwrap();
                                    },
                                    _ => {
                                        log_and_emit(&window, role, "INVALID_REDEMPTION", "Invalid redemption message format").await;
                                        window.emit("ERROR", "Invalid redemption message format").unwrap();
                                    }
                                }
                            } else {
                                log_and_emit(&window, role, "ENCRYPTING_MESSAGE", &format!("Encrypting message: {}", message)).await;
                                send_encrypted_message(&mut stream, &session_keys, &message).await;
                                window.emit("MESSAGE_SENT", message).unwrap();
                            }
                        },
                        _ => {
                            log_and_emit(&window, role, "MESSAGE_SEND_ERROR", "Cannot send message: not in encrypted state").await;
                            window.emit("ERROR", "Cannot send message: not in encrypted state").unwrap();
                        }
                    }
                }
            }
            // Connection timeout check
            _ = tokio::time::sleep(connection_timeout) => {
                if last_activity.elapsed() > connection_timeout {
                    log_and_emit(&window, role, "CONNECTION_TIMEOUT", "Connection timed out due to inactivity").await;
                    window.emit("ERROR", "Connection timed out").ok();
                    window.emit("PEER_DISCONNECT", "Connection timeout").ok();
                    
                    // Try to send disconnect notice
                    let _ = send_disconnect(&mut stream, &session_keys, "Connection timeout").await;
                    
                    clear_shared_connection_state(&window).await;
                    break;
                }
            }
        } // end select
    } // end loop
    
    // Cleanup connection state when loop exits
    log_and_emit(&window, role, "CONNECTION_ENDED", "Connection loop ended, cleaning up").await;
    clear_shared_connection_state(&window).await;
} // end handle_connection

async fn encrypt_message(
    keys: &SessionKeys,
    plaintext: &str,
) -> Result<(Vec<u8>, [u8; 12]), String> {
    let mut nonce_counter = keys.send_nonce.lock().await;
    let nonce_bytes = (*nonce_counter).to_be_bytes();
    *nonce_counter += 1;

    let mut nonce = [0u8; 12];
    nonce[..8].copy_from_slice(&nonce_bytes);

    let aead_nonce = aead::Nonce::assume_unique_for_key(nonce);
    let mut in_out = plaintext.as_bytes().to_vec();

    keys.encryption_key
        .seal_in_place_append_tag(aead_nonce, aead::Aad::empty(), &mut in_out)
        .map_err(|_| "Encryption failed".to_string())?;

    Ok((in_out, nonce))
}

async fn decrypt_message(
    keys: &SessionKeys,
    ciphertext: &[u8],
    nonce: &[u8; 12],
) -> Result<String, String> {
    let aead_nonce = aead::Nonce::assume_unique_for_key(*nonce);
    let mut in_out = ciphertext.to_vec();

    let plaintext_bytes = keys
        .decryption_key
        .open_in_place(aead_nonce, aead::Aad::empty(), &mut in_out)
        .map_err(|_| "Decryption failed".to_string())?;

    String::from_utf8(plaintext_bytes.to_vec()).map_err(|_| "Invalid UTF-8".to_string())
}

async fn log_and_emit(window: &Window, role: &str, event: &str, details: &str) {
    let log_msg = format!("[{}] {}: {}", role, event, details);
    println!("{}", log_msg);
    window.emit("PROTOCOL_LOG", log_msg).unwrap();
}

async fn send_message(stream: &mut TcpStream, msg: &Message) {
    if let Ok(json) = serde_json::to_string(msg) {
        let message_with_delimiter = format!("{}\n", json);
        let _ = stream.write_all(message_with_delimiter.as_bytes()).await;
    }
}

async fn send_encrypted_message(
    stream: &mut TcpStream,
    session_keys: &Option<SessionKeys>,
    plaintext: &str,
) {
    if let Some(keys) = session_keys {
        match encrypt_message(keys, plaintext).await {
            Ok((ciphertext, nonce)) => {
                println!(
                    "[ENCRYPTION] Encrypted message: {} -> {} bytes, nonce: {}",
                    plaintext,
                    ciphertext.len(),
                    hex::encode(&nonce)
                );
                let msg = Message::EncryptedMessage { ciphertext, nonce };
                send_message(stream, &msg).await;
            }
            Err(e) => {
                eprintln!("[ENCRYPTION_ERROR] Failed to encrypt message: {}", e);
            }
        }
    }
}

pub async fn send_disconnect(stream: &mut TcpStream, keys: &Option<SessionKeys>, reason: &str) {
    // Serialize a Disconnect message and encrypt inside EncryptedMessage for graceful shutdown
    if let Some(session_keys) = keys {
        if let Ok(serialized) = serde_json::to_string(&Message::Disconnect { reason: reason.to_string() }) {
            match encrypt_message(session_keys, &serialized).await {
                Ok((ciphertext, nonce)) => {
                    let msg = Message::EncryptedMessage { ciphertext, nonce };
                    send_message(stream, &msg).await;
                },
                Err(e) => {
                    eprintln!("[DISCONNECT] Failed to encrypt disconnect message: {}", e);
                }
            }
        }
    }
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
        let audio_len = audio.len();
        let redemption_msg = Message::RedemptionMessage {
            audio,
            title,
            content,
            message_type,
            time,
        };
        match serde_json::to_string(&redemption_msg) {
            Ok(serialized) => match encrypt_message(keys, &serialized).await {
                Ok((ciphertext, nonce)) => {
                    println!("[REDEMPTION] Encrypted redemption: type {}, {} bytes audio -> {} bytes ciphertext", message_type, audio_len, ciphertext.len());
                    let msg = Message::EncryptedMessage { ciphertext, nonce };
                    send_message(stream, &msg).await;
                }
                Err(e) => {
                    eprintln!("[REDEMPTION_ERROR] Failed to encrypt redemption message: {}", e);
                }
            },
            Err(e) => {
                eprintln!("[REDEMPTION_ERROR] Failed to serialize redemption message: {}", e);
            }
        }
    }
}

// Helper functions for shared connection state management
async fn update_shared_connection_state(window: &Window, new_state: Option<ConnectionState>) {
    let handle = window.app_handle();
    if let Some(app_state) = handle.try_state::<AppStateWithChannel>() {
        let mut cs = app_state.connection_state.lock().await;
        *cs = new_state.clone();
    }
    if matches!(new_state, Some(ConnectionState::Encrypted)) {
        let _ = window.emit("CLIENT_CONNECTED", "");
        let _ = window.emit("SUCCESS", "Client connection established");
    }
}

async fn clear_shared_connection_state(window: &Window) {
    let handle = window.app_handle();
    if let Some(app_state) = handle.try_state::<AppStateWithChannel>() {
        {
            let mut tx = app_state.message_tx.lock().await;
            *tx = None;
        }
        {
            let mut cs = app_state.connection_state.lock().await;
            *cs = None;
        }
    }
    let _ = window.emit("CLIENT_DISCONNECTED", "");
    let _ = window.emit("STATUS_UPDATE", "Connection closed");
}
