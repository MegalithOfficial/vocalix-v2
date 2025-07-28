// src-tauri/src/main.rs

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod pairing;
mod twitch_oauth;
mod twitch;

use pairing::AppState;
use twitch_oauth::TwitchAuthManager;
use twitch::{TwitchEventSub, EventSubEvent, parse_channel_points_redemption, create_common_subscriptions};
use p256::ecdh::EphemeralSecret;
use ring::aead;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Emitter, State, Window};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Mutex, mpsc};

// --- Connection State ---
#[derive(Debug, Clone)]
enum ConnectionState {
    Authenticating,
    WaitingForUserConfirmation,
    WaitingForPeerConfirmation,
    Encrypted,
}

// --- Session Keys ---
struct SessionKeys {
    encryption_key: aead::LessSafeKey,
    decryption_key: aead::LessSafeKey,
    send_nonce: Arc<Mutex<u64>>,
    recv_nonce: Arc<Mutex<u64>>,
}

// --- AppState with Communication Channel ---
pub struct AppStateWithChannel {
    pub inner: AppState,
    pub confirmation_tx: broadcast::Sender<bool>,
    pub message_tx: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
}

// Add Twitch state management
#[derive(Default)]
pub struct TwitchState {
    pub auth_manager: Arc<Mutex<Option<TwitchAuthManager>>>,
    pub event_sub: Arc<Mutex<Option<TwitchEventSub>>>,
}

// --- Network Message Protocol (Complete) ---
#[derive(Serialize, Deserialize, Debug)]
enum Message {
    // Initial handshake
    Hello(Vec<u8>),
    Challenge { nonce: Vec<u8>, listener_pub_key: Vec<u8> },
    ChallengeResponse(Vec<u8>),
    
    // Key exchange for new peers
    InitialDhKey(Vec<u8>),
    ResponseDhKey(Vec<u8>),
    
    // Pairing coordination
    PairingConfirmed, // Sent after user confirms pairing
    
    // Session establishment
    SessionKeyRequest(Vec<u8>), // Ephemeral public key for session
    SessionKeyResponse(Vec<u8>), // Ephemeral public key response
    EncryptionReady,
    
    // Encrypted communication
    EncryptedMessage { ciphertext: Vec<u8>, nonce: [u8; 12] },
    
    // Redemption protocol messages (server -> client only)
    RedemptionMessage { 
        audio: Vec<u8>, 
        title: String, 
        content: String, 
        message_type: u8,  // 0 = without timer, 1 = with timer
        time: Option<u32>  // time in seconds, only present when message_type = 1
    },
    
    // Test message
    PlaintextMessage(String), // For testing before encryption
}

// --- Tauri Commands ---

#[tauri::command]
async fn start_listener(window: Window, state: State<'_, AppStateWithChannel>) -> Result<(), String> {
    window.emit("STATUS_UPDATE", "Starting listener...").unwrap();
    let listener = TcpListener::bind("0.0.0.0:12345").await.map_err(|e| e.to_string())?;
    window.emit("STATUS_UPDATE", "Listening on 0.0.0.0:12345").unwrap();

    let (stream, addr) = listener.accept().await.map_err(|e| e.to_string())?;
    window.emit("STATUS_UPDATE", format!("Accepted connection from {}", addr)).unwrap();
    
    let confirmation_rx = state.confirmation_tx.subscribe();
    tokio::spawn(handle_connection(stream, window, state.inner.clone(), confirmation_rx, state.message_tx.clone(), false));
    
    Ok(())
}

#[tauri::command]
async fn start_initiator(address: String, window: Window, state: State<'_, AppStateWithChannel>) -> Result<(), String> {
    window.emit("STATUS_UPDATE", format!("Connecting to {}...", address)).unwrap();
    let stream = TcpStream::connect(address).await.map_err(|e| e.to_string())?;
    window.emit("STATUS_UPDATE", "Connection established!").unwrap();

    let confirmation_rx = state.confirmation_tx.subscribe();
    tokio::spawn(handle_connection(stream, window, state.inner.clone(), confirmation_rx, state.message_tx.clone(), true));

    Ok(())
}

#[tauri::command]
async fn user_confirm_pairing(state: State<'_, AppStateWithChannel>) -> Result<(), String> {
    state.confirmation_tx.send(true).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn send_chat_message(message: String, state: State<'_, AppStateWithChannel>) -> Result<(), String> {
    let message_tx = state.message_tx.lock().await;
    if let Some(tx) = message_tx.as_ref() {
        tx.send(message).map_err(|e| format!("Failed to send message: {}", e))?;
        Ok(())
    } else {
        Err("No active connection".to_string())
    }
}

#[tauri::command]
async fn send_redemption_without_timer(
    audio: Vec<u8>, 
    title: String, 
    content: String, 
    state: State<'_, AppStateWithChannel>
) -> Result<(), String> {
    let message_tx = state.message_tx.lock().await;
    if let Some(tx) = message_tx.as_ref() {
        let redemption_msg = Message::RedemptionMessage {
            audio,
            title,
            content,
            message_type: 0, // redemption-without-timer
            time: None,
        };
        let serialized = serde_json::to_string(&redemption_msg)
            .map_err(|e| format!("Failed to serialize redemption message: {}", e))?;
        tx.send(serialized).map_err(|e| format!("Failed to send redemption message: {}", e))?;
        Ok(())
    } else {
        Err("No active connection".to_string())
    }
}

#[tauri::command]
async fn send_redemption_with_timer(
    audio: Vec<u8>, 
    title: String, 
    content: String, 
    time: u32, 
    state: State<'_, AppStateWithChannel>
) -> Result<(), String> {
    let message_tx = state.message_tx.lock().await;
    if let Some(tx) = message_tx.as_ref() {
        let redemption_msg = Message::RedemptionMessage {
            audio,
            title,
            content,
            message_type: 1, // redemption-with-timer
            time: Some(time),
        };
        let serialized = serde_json::to_string(&redemption_msg)
            .map_err(|e| format!("Failed to serialize redemption message: {}", e))?;
        tx.send(serialized).map_err(|e| format!("Failed to send redemption message: {}", e))?;
        Ok(())
    } else {
        Err("No active connection".to_string())
    }
}


#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", &url])
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    Ok(())
}

// === TWITCH OAUTH COMMANDS ===

#[tauri::command]
async fn twitch_authenticate(
    client_id: String,
    client_secret: Option<String>,
    window: Window,
    twitch_state: State<'_, TwitchState>
) -> Result<String, String> {
    window.emit("STATUS_UPDATE", "Starting Twitch Device Code Grant authentication...").unwrap();
    
    let auth_manager = TwitchAuthManager::new(client_id, client_secret);
    
    match auth_manager.authenticate().await {
        Ok((_tokens, user_instructions)) => {
            // Store the auth manager in state
            *twitch_state.auth_manager.lock().await = Some(auth_manager);
            
            // Emit user instructions for the UI
            window.emit("TWITCH_DEVICE_CODE", user_instructions).unwrap();
            
            // Get user info to return
            if let Some(auth_manager) = twitch_state.auth_manager.lock().await.as_ref() {
                match auth_manager.get_user_info().await {
                    Ok(user_info) => {
                        window.emit("TWITCH_AUTH_SUCCESS", &user_info).unwrap();
                        Ok(format!("Authenticated as {}", user_info.display_name))
                    }
                    Err(e) => {
                        window.emit("ERROR", format!("Failed to get user info: {}", e)).unwrap();
                        Err(format!("Failed to get user info: {}", e))
                    }
                }
            } else {
                Err("Auth manager not found in state".to_string())
            }
        }
        Err(e) => {
            window.emit("ERROR", format!("Twitch authentication failed: {}", e)).unwrap();
            Err(format!("Authentication failed: {}", e))
        }
    }
}

#[tauri::command]
async fn twitch_start_event_listener(
    window: Window,
    twitch_state: State<'_, TwitchState>
) -> Result<(), String> {
    // Clone the auth manager before the scope ends
    let auth_manager = {
        let auth_guard = twitch_state.auth_manager.lock().await;
        match auth_guard.as_ref() {
            Some(manager) => manager.clone(),
            None => return Err("Not authenticated with Twitch".to_string()),
        }
    };

    window.emit("STATUS_UPDATE", "Starting Twitch event listener...").unwrap();

    // Get valid tokens
    let tokens = auth_manager.get_valid_tokens().await
        .map_err(|e| format!("Failed to get valid tokens: {}", e))?;

    // Create EventSub instance
    let event_sub = TwitchEventSub::new(
        auth_manager.get_client_id().to_string(),
        tokens.access_token.clone()
    );

    // Get event receiver before connecting
    let mut event_receiver = event_sub.get_event_receiver().await;
    
    // Store the EventSub instance before connecting
    *twitch_state.event_sub.lock().await = Some(event_sub.clone());
    
    // Spawn event handler task
    let window_clone = window.clone();
    tokio::spawn(async move {
        while let Some(event) = event_receiver.recv().await {
            if let Err(e) = handle_twitch_event(&window_clone, event).await {
                eprintln!("Error handling Twitch event: {}", e);
            }
        }
    });

    // Connect to EventSub WebSocket
    let connect_event_sub = event_sub.clone();
    tokio::spawn(async move {
        if let Err(e) = connect_event_sub.connect().await {
            eprintln!("EventSub connection error: {}", e);
        }
    });

    // Wait a moment for the welcome message
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    // Subscribe to events after connection is established
    match auth_manager.validate_current_tokens().await {
        Ok(validation) => {
            if let Some(user_id) = validation.user_id {
                // Subscribe to channel points redemptions
                if let Err(e) = event_sub.subscribe_to_channel_points(&user_id).await {
                    window.emit("ERROR", format!("Failed to subscribe to channel points: {}", e)).unwrap();
                } else {
                    window.emit("STATUS_UPDATE", "Subscribed to channel point redemptions!").unwrap();
                }
                
                // Subscribe to other common events
                let common_subscriptions = create_common_subscriptions(&user_id);
                if let Err(e) = event_sub.subscribe_to_events(common_subscriptions).await {
                    window.emit("ERROR", format!("Failed to subscribe to events: {}", e)).unwrap();
                } else {
                    window.emit("STATUS_UPDATE", "Subscribed to Twitch events!").unwrap();
                }
            }
        }
        Err(e) => {
            window.emit("ERROR", format!("Failed to validate tokens: {}", e)).unwrap();
        }
    }

    window.emit("STATUS_UPDATE", "Event listener started successfully!").unwrap();
    Ok(())
}

#[tauri::command]
async fn twitch_get_user_info(twitch_state: State<'_, TwitchState>) -> Result<serde_json::Value, String> {
    // Clone the auth manager before the scope ends
    let auth_manager = {
        let auth_guard = twitch_state.auth_manager.lock().await;
        match auth_guard.as_ref() {
            Some(manager) => manager.clone(),
            None => return Err("Not authenticated with Twitch".to_string()),
        }
    };

    match auth_manager.get_user_info().await {
        Ok(user_info) => Ok(serde_json::to_value(user_info).unwrap()),
        Err(e) => Err(format!("Failed to get user info: {}", e))
    }
}

#[tauri::command]
async fn twitch_sign_out(
    window: Window,
    twitch_state: State<'_, TwitchState>
) -> Result<(), String> {
    if let Some(auth_manager) = twitch_state.auth_manager.lock().await.take() {
        match auth_manager.sign_out().await {
            Ok(_) => {
                window.emit("TWITCH_SIGNED_OUT", "Successfully signed out").unwrap();
                Ok(())
            }
            Err(e) => Err(format!("Failed to sign out: {}", e))
        }
    } else {
        Ok(()) // Already signed out
    }
}

#[tauri::command]
async fn twitch_is_authenticated(twitch_state: State<'_, TwitchState>) -> Result<bool, String> {
    let auth_manager_exists = twitch_state.auth_manager.lock().await.is_some();
    Ok(auth_manager_exists && TwitchAuthManager::is_authenticated())
}

// Helper function to handle Twitch EventSub events
async fn handle_twitch_event(window: &Window, event: EventSubEvent) -> Result<(), Box<dyn std::error::Error>> {
    match event {
        EventSubEvent::SessionWelcome(session) => {
            println!("WebSocket session established: {}", session.id);
            window.emit("STATUS_UPDATE", "WebSocket session established")?;
        }
        
        EventSubEvent::SessionReconnect(session) => {
            println!("Reconnecting to new session: {}", session.id);
            window.emit("STATUS_UPDATE", "Reconnecting to new session...")?;
        }
        
        EventSubEvent::Notification { subscription_type, event, .. } => {
            println!("Received notification: {}", subscription_type);
            
            match subscription_type.as_str() {
                "channel.channel_points_custom_reward_redemption.add" => {
                    match parse_channel_points_redemption(&event) {
                        Ok(redemption) => {
                            println!("Channel points redemption: {} redeemed '{}' for {} points", 
                                redemption.user_name, 
                                redemption.reward.title, 
                                redemption.reward.cost
                            );

                            let redemption_data = serde_json::json!({
                                "id": redemption.id,
                                "user_name": redemption.user_name,
                                "user_input": redemption.user_input,
                                "reward_title": redemption.reward.title,
                                "reward_cost": redemption.reward.cost,
                                "reward_prompt": redemption.reward.prompt,
                                "redeemed_at": redemption.redeemed_at.to_rfc3339(),
                            });

                            window.emit("TWITCH_CHANNEL_POINTS_REDEMPTION", redemption_data)?;
                        }
                        Err(e) => {
                            eprintln!("Failed to parse channel points redemption: {}", e);
                        }
                    }
                }
                _ => {
                    println!("Unhandled event type: {}", subscription_type);
                    // Forward other events as generic events
                    let event_data = serde_json::json!({
                        "type": subscription_type,
                        "data": event
                    });
                    window.emit("TWITCH_EVENT", event_data)?;
                }
            }
        }
        
        EventSubEvent::Revocation { subscription_type, .. } => {
            println!("Subscription revoked: {}", subscription_type);
            window.emit("ERROR", format!("Subscription revoked: {}", subscription_type))?;
        }
        
        EventSubEvent::Keepalive => {
            // Keepalive messages don't need special handling
        }
        
        EventSubEvent::ConnectionStateChanged(state) => {
            println!("Connection state changed: {:?}", state);
            let status = match state {
                twitch::EventSubConnectionState::Connecting => "Connecting to Twitch...",
                twitch::EventSubConnectionState::Connected => "Connected to Twitch",
                twitch::EventSubConnectionState::Reconnecting => "Reconnecting...",
                twitch::EventSubConnectionState::Disconnected => "Disconnected from Twitch",
                twitch::EventSubConnectionState::Failed => "Connection failed",
            };
            window.emit("STATUS_UPDATE", status)?;
        }
        
        EventSubEvent::Error(error) => {
            println!("EventSub error: {}", error);
            window.emit("ERROR", error)?;
        }
    }
    
    Ok(())
}

// --- Core Connection Handler with Complete Encryption ---
async fn handle_connection(
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
    
    log_and_emit(&window, role, "IDENTITY_LOADED", &format!("My public key: {}...", &my_pub_key_hex[..16])).await;

    // Connection state
    let mut connection_state = ConnectionState::Authenticating;
    let mut peer_public_key_hex: Option<String> = None;
    let mut long_term_secret: Option<Vec<u8>> = None;
    let mut temp_dh_private_key: Option<EphemeralSecret> = None;
    let mut session_keys: Option<SessionKeys> = None;
    let mut challenge_nonce: Option<Vec<u8>> = None;

    // Create message channel for UI to send messages
    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<String>();
    
    // Set the message sender in the shared state so UI can send messages
    {
        let mut shared_tx = message_tx.lock().await;
        *shared_tx = Some(msg_tx);
    }

    // Start the protocol if we're the initiator
    if is_initiator {
        log_and_emit(&window, role, "PROTOCOL_START", "Sending Hello message").await;
        let msg = Message::Hello(my_public_key_bytes.clone());
        send_message(&mut stream, &msg).await;
    } else {
        log_and_emit(&window, role, "PROTOCOL_START", "Waiting for Hello message").await;
    }

    let mut buffer = vec![0; 8192];
    loop {
        tokio::select! {
            // Handle incoming network messages
            result = stream.read(&mut buffer) => {
                let n = match result {
                    Ok(0) => { 
                        window.emit("STATUS_UPDATE", "Connection closed.").unwrap(); 
                        break; 
                    },
                    Ok(n) => n,
                    Err(e) => { 
                        window.emit("ERROR", format!("Read error: {}", e)).unwrap(); 
                        break; 
                    }
                };

                let received_msg: Message = match serde_json::from_slice(&buffer[..n]) {
                    Ok(msg) => {
                        log_and_emit(&window, role, "MESSAGE_RECEIVED", &format!("{:?}", msg)).await;
                        msg
                    },
                    Err(e) => { 
                        log_and_emit(&window, role, "PARSE_ERROR", &format!("Failed to parse message: {}", e)).await;
                        window.emit("ERROR", format!("Parse error: {}", e)).unwrap(); 
                        continue; 
                    }
                };

                // Process the message based on current state
                match (&connection_state, &received_msg) {
                    // === AUTHENTICATION PHASE ===
                    (ConnectionState::Authenticating, Message::Hello(peer_key)) => {
                        peer_public_key_hex = Some(hex::encode(peer_key));
                        let peer_key_short = &peer_public_key_hex.as_ref().unwrap()[..16];
                        log_and_emit(&window, role, "HELLO_RECEIVED", &format!("From peer: {}...", peer_key_short)).await;
                        
                        let peers = state.known_peers.lock().await;

                        if let Some(secret) = peers.get(peer_public_key_hex.as_ref().unwrap()) {
                            // Known peer - challenge them
                            long_term_secret = Some(secret.clone());
                            log_and_emit(&window, role, "KNOWN_PEER", "Peer found in database, sending challenge").await;
                            window.emit("STATUS_UPDATE", "Known peer found. Sending challenge...").unwrap();
                            
                            let nonce: [u8; 16] = rand::random();
                            challenge_nonce = Some(nonce.to_vec());
                            let msg = Message::Challenge { 
                                nonce: nonce.to_vec(), 
                                listener_pub_key: my_public_key_bytes.clone() 
                            };
                            log_and_emit(&window, role, "CHALLENGE_SENT", &format!("Challenge nonce: {}", hex::encode(&nonce))).await;
                            send_message(&mut stream, &msg).await;
                        } else {
                            // New peer - start DH exchange for pairing
                            log_and_emit(&window, role, "NEW_PEER", "Unknown peer, starting DH key exchange").await;
                            window.emit("STATUS_UPDATE", "New peer. Starting DH exchange...").unwrap();
                            let (priv_key, pub_key) = pairing::perform_dh_exchange();
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
                            let signature = pairing::create_challenge_signature(secret, nonce);
                            let msg = Message::ChallengeResponse(signature.as_ref().to_vec());
                            log_and_emit(&window, role, "CHALLENGE_RESPONSE_SENT", &format!("Signature: {}", hex::encode(signature.as_ref()))).await;
                            send_message(&mut stream, &msg).await;
                            // After sending challenge response, we're ready for session key establishment
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
                            if pairing::verify_challenge_signature(secret, nonce, signature) {
                                log_and_emit(&window, role, "AUTH_SUCCESS", "Challenge signature verified successfully").await;
                                window.emit("STATUS_UPDATE", "Authentication successful! Setting up secure session...").unwrap();
                                // Proceed to session key establishment
                                let (session_priv, session_pub) = pairing::perform_dh_exchange();
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
                        let (priv_key, pub_key) = pairing::perform_dh_exchange();
                        let peer_public_key = p256::PublicKey::from_sec1_bytes(peer_dh_key).unwrap();
                        let shared_secret = priv_key.diffie_hellman(&peer_public_key);
                        long_term_secret = Some(shared_secret.raw_secret_bytes().to_vec());

                        let code = pairing::generate_6_digit_code(long_term_secret.as_ref().unwrap());
                        window.emit("PAIRING_REQUIRED", code).unwrap();
                        
                        temp_dh_private_key = Some(priv_key);
                        let msg = Message::ResponseDhKey(pub_key.to_sec1_bytes().into_vec());
                        send_message(&mut stream, &msg).await;
                        
                        connection_state = ConnectionState::WaitingForUserConfirmation;
                    },
                    
                    (ConnectionState::Authenticating, Message::ResponseDhKey(peer_dh_key)) => {
                        let peer_public_key = p256::PublicKey::from_sec1_bytes(peer_dh_key).unwrap();
                        let shared_secret = temp_dh_private_key.take().unwrap()
                            .diffie_hellman(&peer_public_key);
                        long_term_secret = Some(shared_secret.raw_secret_bytes().to_vec());
                        
                        let code = pairing::generate_6_digit_code(long_term_secret.as_ref().unwrap());
                        window.emit("PAIRING_REQUIRED", code).unwrap();
                        window.emit("STATUS_UPDATE", "Code displayed. Waiting for user confirmation...").unwrap();
                        
                        connection_state = ConnectionState::WaitingForUserConfirmation;
                    },

                    (ConnectionState::WaitingForUserConfirmation, Message::PairingConfirmed) => {
                        log_and_emit(&window, role, "PEER_CONFIRMED", "Peer has confirmed pairing").await;
                        window.emit("STATUS_UPDATE", "Peer confirmed pairing. Setting up secure session...").unwrap();
                        
                        // Now establish session keys for forward secrecy
                        let (session_priv, session_pub) = pairing::perform_dh_exchange();
                        temp_dh_private_key = Some(session_priv);
                        let msg = Message::SessionKeyRequest(session_pub.to_sec1_bytes().into_vec());
                        log_and_emit(&window, role, "POST_PAIRING_SESSION_REQUEST", "Requesting session keys after both confirmed").await;
                        send_message(&mut stream, &msg).await;
                        connection_state = ConnectionState::Authenticating;
                    },

                    (ConnectionState::WaitingForPeerConfirmation, Message::PairingConfirmed) => {
                        log_and_emit(&window, role, "PEER_CONFIRMED", "Peer has confirmed pairing, ready for session keys").await;
                        window.emit("STATUS_UPDATE", "Both peers confirmed. Ready for session keys...").unwrap();
                        connection_state = ConnectionState::Authenticating;
                    },

                    // === SESSION KEY ESTABLISHMENT ===
                    (ConnectionState::Authenticating, Message::SessionKeyRequest(session_pub_key)) => {
                        log_and_emit(&window, role, "SESSION_KEY_REQUEST_RECEIVED", "Creating session keys from ephemeral DH").await;
                        window.emit("STATUS_UPDATE", "Creating session keys...").unwrap();
                        let (session_priv, my_session_pub) = pairing::perform_dh_exchange();
                        
                        // Create session keys using the session DH exchange
                        match pairing::create_session_keys(&session_priv, session_pub_key) {
                            Ok((decryption_key, encryption_key)) => {
                                log_and_emit(&window, role, "SESSION_KEYS_CREATED", "Session encryption keys established").await;
                                session_keys = Some(SessionKeys {
                                    encryption_key,
                                    decryption_key,
                                    send_nonce: Arc::new(Mutex::new(0)),
                                    recv_nonce: Arc::new(Mutex::new(0)),
                                });
                                
                                let msg = Message::SessionKeyResponse(my_session_pub.to_sec1_bytes().into_vec());
                                log_and_emit(&window, role, "SESSION_KEY_RESPONSE_SENT", "Sending session key response").await;
                                send_message(&mut stream, &msg).await;
                                
                                let msg = Message::EncryptionReady;
                                log_and_emit(&window, role, "ENCRYPTION_READY_SENT", "Signaling encryption ready").await;
                                send_message(&mut stream, &msg).await;
                                
                                connection_state = ConnectionState::Encrypted;
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
                            match pairing::create_session_keys(&session_priv, session_pub_key) {
                                Ok((encryption_key, decryption_key)) => {
                                    log_and_emit(&window, role, "SESSION_KEYS_COMPLETED", "Session keys created, waiting for encryption ready").await;
                                    session_keys = Some(SessionKeys {
                                        encryption_key,
                                        decryption_key,
                                        send_nonce: Arc::new(Mutex::new(0)),
                                        recv_nonce: Arc::new(Mutex::new(0)),
                                    });
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
                                    
                                    // Check if this is a redemption message
                                    if let Ok(redemption_msg) = serde_json::from_str::<Message>(&plaintext) {
                                        match redemption_msg {
                                            Message::RedemptionMessage { audio, title, content, message_type, time } => {
                                                let protocol_type = match message_type {
                                                    1 => "redemption-with-timer",
                                                    _ => "redemption-without-timer",
                                                };
                                                
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
                                            _ => {
                                                // Not a redemption message, treat as regular message
                                                window.emit("MESSAGE_RECEIVED", plaintext).unwrap();
                                            }
                                        }
                                    } else {
                                        // Not JSON or not a redemption message, treat as regular chat
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

                    // Handle unexpected messages - but allow SessionKeyRequest in WaitingForPeerConfirmation
                    (ConnectionState::WaitingForPeerConfirmation, Message::SessionKeyRequest(session_pub_key)) => {
                        // Peer confirmed and immediately sent session key request
                        log_and_emit(&window, role, "SESSION_KEY_REQUEST_RECEIVED", "Creating session keys from ephemeral DH").await;
                        window.emit("STATUS_UPDATE", "Creating session keys...").unwrap();
                        let (session_priv, my_session_pub) = pairing::perform_dh_exchange();
                        
                        // Create session keys using the session DH exchange
                        match pairing::create_session_keys(&session_priv, session_pub_key) {
                            Ok((decryption_key, encryption_key)) => {
                                log_and_emit(&window, role, "SESSION_KEYS_CREATED", "Session encryption keys established").await;
                                session_keys = Some(SessionKeys {
                                    encryption_key,
                                    decryption_key,
                                    send_nonce: Arc::new(Mutex::new(0)),
                                    recv_nonce: Arc::new(Mutex::new(0)),
                                });
                                
                                let msg = Message::SessionKeyResponse(my_session_pub.to_sec1_bytes().into_vec());
                                log_and_emit(&window, role, "SESSION_KEY_RESPONSE_SENT", "Sending session key response").await;
                                send_message(&mut stream, &msg).await;
                                
                                let msg = Message::EncryptionReady;
                                log_and_emit(&window, role, "ENCRYPTION_READY_SENT", "Signaling encryption ready").await;
                                send_message(&mut stream, &msg).await;
                                
                                connection_state = ConnectionState::Encrypted;
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

                    // Handle unexpected messages
                    _ => {
                        log_and_emit(&window, role, "UNEXPECTED_MESSAGE", &format!("Message: {:?} in state: {:?}", received_msg, connection_state)).await;
                        window.emit("ERROR", format!("Unexpected message {:?} in state {:?}", received_msg, connection_state)).unwrap();
                    }
                }
            },

            // Handle user confirmation
            result = confirmation_rx.recv() => {
                if let Ok(true) = result {
                    log_and_emit(&window, role, "USER_CONFIRMATION", "User confirmed pairing").await;
                    match connection_state {
                        ConnectionState::WaitingForUserConfirmation => {
                            window.emit("STATUS_UPDATE", "Pairing confirmed by user!").unwrap();
                            
                            if let (Some(key), Some(secret)) = (peer_public_key_hex.clone(), long_term_secret.clone()) {
                                let mut peers = state.known_peers.lock().await;
                                peers.insert(key.clone(), secret);
                                if let Err(e) = pairing::save_known_peers(&peers) {
                                    log_and_emit(&window, role, "SAVE_PEER_ERROR", &format!("Failed to save peer: {}", e)).await;
                                    window.emit("ERROR", format!("Failed to save peer: {}", e)).unwrap();
                                } else {
                                    log_and_emit(&window, role, "PEER_SAVED", &format!("Saved new peer: {}...", &key[..16])).await;
                                    
                                    // Send confirmation to peer and wait for their confirmation
                                    let msg = Message::PairingConfirmed;
                                    log_and_emit(&window, role, "PAIRING_CONFIRMED_SENT", "Sending pairing confirmation to peer").await;
                                    send_message(&mut stream, &msg).await;
                                    
                                    // Transition to waiting for peer confirmation
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

            // Handle messages from UI to send through encrypted channel
            msg = msg_rx.recv() => {
                if let Some(message) = msg {
                    log_and_emit(&window, role, "UI_MESSAGE_REQUEST", &format!("UI wants to send: {}", message)).await;
                    match connection_state {
                        ConnectionState::Encrypted => {
                            // Check if this is a serialized redemption message or regular chat
                            if let Ok(redemption_msg) = serde_json::from_str::<Message>(&message) {
                                // This is a serialized redemption message
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
                                // Regular chat message
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
        }
    }
}

// --- Helper Functions ---

async fn log_and_emit(window: &Window, role: &str, event: &str, details: &str) {
    let log_msg = format!("[{}] {}: {}", role, event, details);
    println!("{}", log_msg);
    window.emit("PROTOCOL_LOG", log_msg).unwrap();
}

async fn send_message(stream: &mut TcpStream, msg: &Message) {
    if let Ok(json) = serde_json::to_string(msg) {
        let _ = stream.write_all(json.as_bytes()).await;
    }
}

async fn send_encrypted_message(
    stream: &mut TcpStream, 
    session_keys: &Option<SessionKeys>, 
    plaintext: &str
) {
    if let Some(keys) = session_keys {
        match encrypt_message(keys, plaintext).await {
            Ok((ciphertext, nonce)) => {
                println!("[ENCRYPTION] Encrypted message: {} -> {} bytes, nonce: {}", 
                    plaintext, ciphertext.len(), hex::encode(&nonce));
                let msg = Message::EncryptedMessage { ciphertext, nonce };
                send_message(stream, &msg).await;
            },
            Err(e) => {
                eprintln!("[ENCRYPTION_ERROR] Failed to encrypt message: {}", e);
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
    time: Option<u32>
) {
    if let Some(keys) = session_keys {
        let audio_len = audio.len(); // Save length before moving
        let redemption_msg = Message::RedemptionMessage {
            audio,
            title,
            content,
            message_type,
            time,
        };
        
        // Serialize the redemption message
        match serde_json::to_string(&redemption_msg) {
            Ok(serialized) => {
                match encrypt_message(keys, &serialized).await {
                    Ok((ciphertext, nonce)) => {
                        println!("[REDEMPTION] Encrypted redemption message: type {}, {} bytes audio -> {} bytes ciphertext", 
                            message_type, audio_len, ciphertext.len());
                        let msg = Message::EncryptedMessage { ciphertext, nonce };
                        send_message(stream, &msg).await;
                    },
                    Err(e) => {
                        eprintln!("[REDEMPTION_ERROR] Failed to encrypt redemption message: {}", e);
                    }
                }
            },
            Err(e) => {
                eprintln!("[REDEMPTION_ERROR] Failed to serialize redemption message: {}", e);
            }
        }
    }
}

async fn encrypt_message(
    keys: &SessionKeys, 
    plaintext: &str
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
    nonce: &[u8; 12]
) -> Result<String, String> {
    let aead_nonce = aead::Nonce::assume_unique_for_key(*nonce);
    let mut in_out = ciphertext.to_vec();
    
    let plaintext_bytes = keys.decryption_key
        .open_in_place(aead_nonce, aead::Aad::empty(), &mut in_out)
        .map_err(|_| "Decryption failed".to_string())?;
    
    String::from_utf8(plaintext_bytes.to_vec())
        .map_err(|_| "Invalid UTF-8".to_string())
}


fn main() {
    let identity = pairing::load_or_create_identity().expect("Failed to get identity.");
    let known_peers = pairing::load_known_peers().expect("Failed to load peers.");
    
    // Create a broadcast channel for UI->Backend communication
    let (tx, _rx) = broadcast::channel(1);

    // Initialize Twitch integration asynchronously in setup
    let app_state = AppStateWithChannel {
        inner: AppState {
            device_identity: Arc::new(Mutex::new(Some(Arc::new(identity)))),
            known_peers: Arc::new(Mutex::new(known_peers)),
        },
        confirmation_tx: tx,
        message_tx: Arc::new(Mutex::new(None)),
    };
    
    let twitch_state = TwitchState::default();
    
    tauri::Builder::default()
        .manage(app_state)
        .manage(twitch_state)
        .setup(|_app| {     
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_listener,
            start_initiator,
            user_confirm_pairing,
            send_chat_message,
            send_redemption_without_timer,
            send_redemption_with_timer,
            open_url,
            twitch_authenticate,
            twitch_start_event_listener,
            twitch_get_user_info,
            twitch_sign_out,
            twitch_is_authenticated,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}