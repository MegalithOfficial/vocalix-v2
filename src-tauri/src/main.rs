// src-tauri/src/main.rs

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod pairing;
mod twitch;
mod twitch_oauth;

use chrono::{DateTime, Utc};
use p256::ecdh::EphemeralSecret;
use pairing::AppState;
use ring::aead;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, Mutex};
use twitch::{
    create_common_subscriptions, parse_channel_points_redemption, EventSubEvent, TwitchEventSub,
};
use twitch_oauth::TwitchAuthManager;

// --- Logging Macros (defined early for use throughout) ---
// Logging macro for internal use
macro_rules! app_log {
    ($level:expr, $component:expr, $($arg:tt)*) => {
        {
            let message = format!($($arg)*);
            let timestamp = chrono::Utc::now().to_rfc3339();

            // Print to console
            match $level {
                "debug" => println!("[{}] [DEBUG] [{}] {}", timestamp, $component, message),
                "info" => println!("[{}] [INFO] [{}] {}", timestamp, $component, message),
                "warn" => eprintln!("[{}] [WARN] [{}] {}", timestamp, $component, message),
                "error" => eprintln!("[{}] [ERROR] [{}] {}", timestamp, $component, message),
                _ => println!("[{}] [{}] [{}] {}", timestamp, $level.to_uppercase(), $component, message),
            }

            // Write to file asynchronously (best effort)
            // Note: The log file path will be updated in setup() to use app data directory
            let log_file_path = "logs/vocalix.log".to_string();
            let log_line = format!(
                "[{}] [{}] [{}] {}\n",
                timestamp,
                $level.to_uppercase(),
                $component,
                message
            );

            std::thread::spawn(move || {
                use std::fs::{create_dir_all, OpenOptions};
                use std::io::Write;
                use std::path::Path;

                // Create logs directory if it doesn't exist
                if let Some(parent) = Path::new(&log_file_path).parent() {
                    let _ = create_dir_all(parent);
                }

                if let Ok(mut file) = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_file_path)
                {
                    let _ = file.write_all(log_line.as_bytes());
                    let _ = file.flush();
                }
            });
        }
    };
}

// Convenience macros
macro_rules! log_debug { ($component:expr, $($arg:tt)*) => { app_log!("debug", $component, $($arg)*); }; }
macro_rules! log_info { ($component:expr, $($arg:tt)*) => { app_log!("info", $component, $($arg)*); }; }
macro_rules! log_warn { ($component:expr, $($arg:tt)*) => { app_log!("warn", $component, $($arg)*); }; }
macro_rules! log_error { ($component:expr, $($arg:tt)*) => { app_log!("error", $component, $($arg)*); }; }

// --- Logging Types ---
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LogEntry {
    timestamp: String,
    level: String,
    component: String,
    message: String,
}

// --- Logging State ---
pub struct LoggingState {
    log_file_path: Arc<std::sync::Mutex<String>>,
}

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
    Challenge {
        nonce: Vec<u8>,
        listener_pub_key: Vec<u8>,
    },
    ChallengeResponse(Vec<u8>),

    // Key exchange for new peers
    InitialDhKey(Vec<u8>),
    ResponseDhKey(Vec<u8>),

    // Pairing coordination
    PairingConfirmed, // Sent after user confirms pairing

    // Session establishment
    SessionKeyRequest(Vec<u8>),  // Ephemeral public key for session
    SessionKeyResponse(Vec<u8>), // Ephemeral public key response
    EncryptionReady,

    // Encrypted communication
    EncryptedMessage {
        ciphertext: Vec<u8>,
        nonce: [u8; 12],
    },

    // Redemption protocol messages (server -> client only)
    RedemptionMessage {
        audio: Vec<u8>,
        title: String,
        content: String,
        message_type: u8,  // 0 = without timer, 1 = with timer
        time: Option<u32>, // time in seconds, only present when message_type = 1
    },

    // Test message
    PlaintextMessage(String), // For testing before encryption
}

// --- Tauri Commands ---

#[tauri::command]
async fn start_listener(
    window: Window,
    state: State<'_, AppStateWithChannel>,
) -> Result<(), String> {
    window
        .emit("STATUS_UPDATE", "Starting listener...")
        .unwrap();
    let listener = TcpListener::bind("0.0.0.0:12345")
        .await
        .map_err(|e| e.to_string())?;
    window
        .emit("STATUS_UPDATE", "Listening on 0.0.0.0:12345")
        .unwrap();

    let (stream, addr) = listener.accept().await.map_err(|e| e.to_string())?;
    window
        .emit(
            "STATUS_UPDATE",
            format!("Accepted connection from {}", addr),
        )
        .unwrap();

    let confirmation_rx = state.confirmation_tx.subscribe();
    tokio::spawn(handle_connection(
        stream,
        window,
        state.inner.clone(),
        confirmation_rx,
        state.message_tx.clone(),
        false,
    ));

    Ok(())
}

#[tauri::command]
async fn start_initiator(
    address: String,
    window: Window,
    state: State<'_, AppStateWithChannel>,
) -> Result<(), String> {
    window
        .emit("STATUS_UPDATE", format!("Connecting to {}...", address))
        .unwrap();
    let stream = TcpStream::connect(address)
        .await
        .map_err(|e| e.to_string())?;
    window
        .emit("STATUS_UPDATE", "Connection established!")
        .unwrap();

    let confirmation_rx = state.confirmation_tx.subscribe();
    tokio::spawn(handle_connection(
        stream,
        window,
        state.inner.clone(),
        confirmation_rx,
        state.message_tx.clone(),
        true,
    ));

    Ok(())
}

#[tauri::command]
async fn user_confirm_pairing(state: State<'_, AppStateWithChannel>) -> Result<(), String> {
    state
        .confirmation_tx
        .send(true)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn send_chat_message(
    message: String,
    state: State<'_, AppStateWithChannel>,
) -> Result<(), String> {
    let message_tx = state.message_tx.lock().await;
    if let Some(tx) = message_tx.as_ref() {
        tx.send(message)
            .map_err(|e| format!("Failed to send message: {}", e))?;
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
    state: State<'_, AppStateWithChannel>,
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
        tx.send(serialized)
            .map_err(|e| format!("Failed to send redemption message: {}", e))?;
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
    state: State<'_, AppStateWithChannel>,
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
        tx.send(serialized)
            .map_err(|e| format!("Failed to send redemption message: {}", e))?;
        Ok(())
    } else {
        Err("No active connection".to_string())
    }
}

#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    log_info!("URLHandler", "Attempting to open URL: {}", url);

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url]) // Added empty string for title to handle URLs with special chars
            .spawn()
            .map_err(|e| format!("Failed to open URL on Windows: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL on macOS: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        // Try multiple fallback options for Linux
        let commands = [
            "xdg-open",
            "gnome-open",
            "kde-open",
            "firefox",
            "chromium",
            "google-chrome",
        ];
        let mut success = false;

        for cmd in &commands {
            if let Ok(mut child) = std::process::Command::new(cmd)
                .arg(&url)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                // Don't wait for the command to finish, just let it run
                let _ = child.wait();
                success = true;
                log_info!("URLHandler", "Successfully opened URL with: {}", cmd);
                break;
            }
        }

        if !success {
            return Err(format!(
                "Failed to open URL on Linux. Tried: {:?}. Please open manually: {}",
                commands, url
            ));
        }
    }

    log_info!("URLHandler", "URL opened successfully");
    Ok(())
}

// === TWITCH OAUTH COMMANDS ===

#[tauri::command]
async fn twitch_authenticate(
    client_id: String,
    client_secret: Option<String>,
    window: Window,
    twitch_state: State<'_, TwitchState>,
) -> Result<String, String> {
    log_info!(
        "TwitchAuth",
        "Starting Twitch authentication with client_id: {}",
        &client_id[..8.min(client_id.len())]
    );

    window
        .emit(
            "STATUS_UPDATE",
            "Starting Twitch Device Code Grant authentication...",
        )
        .unwrap();

    let auth_manager = TwitchAuthManager::new(client_id, client_secret);

    // Start the device flow and get device code info immediately
    match auth_manager.start_device_flow_async().await {
        Ok(device_response) => {
            // Store the auth manager in state
            *twitch_state.auth_manager.lock().await = Some(auth_manager.clone());

            // Create user instructions with the verification URI
            let user_instructions = if device_response.verification_uri.contains("device-code=") {
                // The URI already contains the device code
                format!(
                    "Please visit {} to complete authentication",
                    device_response.verification_uri
                )
            } else {
                // Need to provide both URI and code separately
                format!(
                    "Please visit {} and enter code: {}",
                    device_response.verification_uri, device_response.user_code
                )
            };

            // Create structured device code info for the frontend
            let device_code_info = serde_json::json!({
                "device_code": device_response.device_code,
                "verification_uri": device_response.verification_uri,
                "user_code": device_response.user_code,
                "expires_in": device_response.expires_in,
                "interval": device_response.interval,
                "instructions": user_instructions
            });

            // Emit device code info for the UI immediately
            window
                .emit("TWITCH_DEVICE_CODE", &device_code_info)
                .unwrap();
            window
                .emit(
                    "STATUS_UPDATE",
                    "Device code generated. Please complete authorization in your browser.",
                )
                .unwrap();

            // Start polling in the background
            let window_clone = window.clone();
            let auth_manager_clone = auth_manager.clone();
            let device_response_clone = device_response.clone();

            tokio::spawn(async move {
                match auth_manager_clone
                    .complete_device_flow(&device_response_clone)
                    .await
                {
                    Ok(_tokens) => {
                        // Get user info after successful authentication
                        match auth_manager_clone.get_user_info().await {
                            Ok(user_info) => {
                                window_clone
                                    .emit("TWITCH_AUTH_SUCCESS", &user_info)
                                    .unwrap();
                                window_clone
                                    .emit(
                                        "STATUS_UPDATE",
                                        format!(
                                            "Successfully authenticated as {}",
                                            user_info.display_name
                                        ),
                                    )
                                    .unwrap();
                            }
                            Err(e) => {
                                window_clone
                                    .emit("ERROR", format!("Failed to get user info: {}", e))
                                    .unwrap();
                            }
                        }
                    }
                    Err(e) => {
                        window_clone
                            .emit("ERROR", format!("Authentication polling failed: {}", e))
                            .unwrap();
                    }
                }
            });

            Ok(
                "Device code flow started. Please complete authorization in your browser."
                    .to_string(),
            )
        }
        Err(e) => {
            window
                .emit("ERROR", format!("Failed to start device flow: {}", e))
                .unwrap();
            Err(format!("Failed to start authentication: {}", e))
        }
    }
}

#[tauri::command]
async fn twitch_start_event_listener(
    window: Window,
    twitch_state: State<'_, TwitchState>,
) -> Result<(), String> {
    // Check if there's already an active EventSub connection
    {
        let event_sub_guard = twitch_state.event_sub.lock().await;
        if event_sub_guard.is_some() {
            window
                .emit("STATUS_UPDATE", "EventSub already connected")
                .unwrap();
            return Ok(());
        }
    }

    // Clone the auth manager before the scope ends
    let auth_manager = {
        let auth_guard = twitch_state.auth_manager.lock().await;
        match auth_guard.as_ref() {
            Some(manager) => manager.clone(),
            None => return Err("Not authenticated with Twitch".to_string()),
        }
    };

    window
        .emit("STATUS_UPDATE", "Starting Twitch event listener...")
        .unwrap();

    // Get valid tokens
    let tokens = auth_manager
        .get_valid_tokens()
        .await
        .map_err(|e| format!("Failed to get valid tokens: {}", e))?;

    // Create EventSub instance
    let event_sub = TwitchEventSub::new(
        auth_manager.get_client_id().to_string(),
        tokens.access_token.clone(),
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
                log_error!("TwitchEventSub", "Error handling Twitch event: {}", e);
            }
        }
    });

    // Connect to EventSub WebSocket
    let connect_event_sub = event_sub.clone();
    tokio::spawn(async move {
        if let Err(e) = connect_event_sub.connect().await {
            log_error!("TwitchEventSub", "EventSub connection error: {}", e);
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
                    window
                        .emit(
                            "ERROR",
                            format!("Failed to subscribe to channel points: {}", e),
                        )
                        .unwrap();
                } else {
                    window
                        .emit("STATUS_UPDATE", "Subscribed to channel point redemptions!")
                        .unwrap();
                }

                // Subscribe to other common events
                let common_subscriptions = create_common_subscriptions(&user_id);
                if let Err(e) = event_sub.subscribe_to_events(common_subscriptions).await {
                    window
                        .emit("ERROR", format!("Failed to subscribe to events: {}", e))
                        .unwrap();
                } else {
                    window
                        .emit("STATUS_UPDATE", "Subscribed to Twitch events!")
                        .unwrap();
                }
            }
        }
        Err(e) => {
            window
                .emit("ERROR", format!("Failed to validate tokens: {}", e))
                .unwrap();
        }
    }

    window
        .emit("STATUS_UPDATE", "Event listener started successfully!")
        .unwrap();
    Ok(())
}

#[tauri::command]
async fn twitch_stop_event_listener(twitch_state: State<'_, TwitchState>) -> Result<(), String> {
    // Clear the EventSub instance
    *twitch_state.event_sub.lock().await = None;
    Ok(())
}

#[tauri::command]
async fn twitch_get_user_info(
    twitch_state: State<'_, TwitchState>,
) -> Result<serde_json::Value, String> {
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
        Err(e) => Err(format!("Failed to get user info: {}", e)),
    }
}

#[tauri::command]
async fn twitch_sign_out(
    window: Window,
    twitch_state: State<'_, TwitchState>,
) -> Result<(), String> {
    if let Some(auth_manager) = twitch_state.auth_manager.lock().await.take() {
        match auth_manager.sign_out().await {
            Ok(_) => {
                window
                    .emit("TWITCH_SIGNED_OUT", "Successfully signed out")
                    .unwrap();
                Ok(())
            }
            Err(e) => Err(format!("Failed to sign out: {}", e)),
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

#[tauri::command]
async fn twitch_save_credentials(
    client_id: String,
    client_secret: Option<String>,
) -> Result<(), String> {
    TwitchAuthManager::save_client_credentials(&client_id, client_secret.as_deref())
        .map_err(|e| format!("Failed to save credentials: {}", e))
}

#[tauri::command]
async fn twitch_load_credentials() -> Result<(String, Option<String>), String> {
    TwitchAuthManager::load_client_credentials()
        .map_err(|e| format!("Failed to load credentials: {}", e))
}

#[tauri::command]
async fn twitch_has_saved_credentials() -> bool {
    TwitchAuthManager::has_saved_credentials()
}

#[tauri::command]
async fn twitch_delete_credentials() -> Result<(), String> {
    TwitchAuthManager::delete_client_credentials()
        .map_err(|e| format!("Failed to delete credentials: {}", e))
}

#[tauri::command]
async fn twitch_get_auth_status(twitch_state: State<'_, TwitchState>) -> Result<String, String> {
    // Try to create auth manager from saved credentials
    let auth_manager = match TwitchAuthManager::from_saved_credentials() {
        Ok(manager) => {
            // Store it in state
            *twitch_state.auth_manager.lock().await = Some(manager.clone());
            manager
        }
        Err(_) => return Ok("no_credentials".to_string()),
    };

    match auth_manager.get_auth_status().await {
        Ok(status) => match status {
            twitch_oauth::AuthStatus::NotAuthenticated => Ok("not_authenticated".to_string()),
            twitch_oauth::AuthStatus::Invalid => Ok("invalid".to_string()),
            twitch_oauth::AuthStatus::Valid => Ok("valid".to_string()),
            twitch_oauth::AuthStatus::ExpiringSoon(_) => Ok("expiring_soon".to_string()),
        },
        Err(e) => Err(format!("Failed to get auth status: {}", e)),
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct TwitchRedemption {
    id: String,
    title: String,
    cost: i32,
    enabled: bool,
    is_enabled: bool,
    prompt: Option<String>,
}

#[tauri::command]
async fn get_twitch_redemptions(
    twitch_state: State<'_, TwitchState>,
) -> Result<Vec<TwitchRedemption>, String> {
    log_info!("TwitchAPI", "Fetching Twitch redemptions");

    // Get the auth manager
    let auth_manager = {
        let auth_guard = twitch_state.auth_manager.lock().await;
        match auth_guard.as_ref() {
            Some(manager) => manager.clone(),
            None => return Err("Not authenticated with Twitch".to_string()),
        }
    };

    // Get user info to get the broadcaster ID
    let user_info = auth_manager
        .get_user_info()
        .await
        .map_err(|e| format!("Failed to get user info: {}", e))?;

    let broadcaster_id = user_info.id; // 1228206540

    // Get valid tokens
    let tokens = auth_manager
        .get_valid_tokens()
        .await
        .map_err(|e| format!("Failed to get access token: {}", e))?;
    let access_token = tokens.access_token;

    // Get client ID
    let (client_id, _) = TwitchAuthManager::load_client_credentials()
        .map_err(|e| format!("Failed to load client credentials: {}", e))?;

    // Make API request to Twitch
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id={}",
        broadcaster_id
    );

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("Client-Id", client_id)
        .send()
        .await
        .map_err(|e| format!("Failed to make API request: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "API request failed with status: {}",
            response.status()
        ));
    }

    let api_response: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse JSON response: {}", e))?;

    // Parse the redemptions
    let mut redemptions = Vec::new();
    if let Some(data) = api_response.get("data").and_then(|d| d.as_array()) {
        for item in data {
            if let Ok(redemption) = serde_json::from_value::<serde_json::Value>(item.clone()) {
                let id = redemption
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let title = redemption
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown")
                    .to_string();
                let cost = redemption.get("cost").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                let enabled = redemption
                    .get("is_enabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let prompt = redemption
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                redemptions.push(TwitchRedemption {
                    id,
                    title,
                    cost,
                    enabled,
                    is_enabled: enabled,
                    prompt,
                });
            }
        }
    }

    Ok(redemptions)
}

// Audio file management commands
#[tauri::command]
async fn save_audio_file(
    app: AppHandle,
    redemption_name: String,
    file_name: String,
    base64_data: String,
) -> Result<(), String> {
    log_info!(
        "AudioManager",
        "Saving audio file: {} for redemption: {}",
        file_name,
        redemption_name
    );

    use base64::{engine::general_purpose, Engine as _};
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // Create the directory structure: static_audios/<redemption_name>/
    let dir_path = app_data_dir.join("static_audios").join(&redemption_name);
    fs::create_dir_all(&dir_path)
        .map_err(|e| format!("Failed to create directory {:?}: {}", dir_path, e))?;

    // Decode base64 data
    let audio_data = general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Failed to decode base64 data: {}", e))?;

    // Write the file
    let file_path = dir_path.join(&file_name);
    fs::write(&file_path, audio_data)
        .map_err(|e| format!("Failed to write file {:?}: {}", file_path, e))?;

    log_info!("AudioManager", "Saved audio file: {:?}", file_path);
    Ok(())
}

#[tauri::command]
async fn get_audio_files(app: AppHandle, redemption_name: String) -> Result<Vec<String>, String> {
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let dir_path = app_data_dir.join("static_audios").join(&redemption_name);

    // Check if directory exists
    if !dir_path.exists() {
        return Ok(Vec::new());
    }

    // Read directory contents
    let entries = fs::read_dir(&dir_path)
        .map_err(|e| format!("Failed to read directory {:?}: {}", dir_path, e))?;

    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_file() {
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                // Only include .mp3 files
                if file_name.ends_with(".mp3") {
                    files.push(file_name.to_string());
                }
            }
        }
    }

    // Sort files for consistent ordering
    files.sort();
    Ok(files)
}

// TTS Settings Management
#[tauri::command]
async fn save_tts_settings(app: AppHandle, config: serde_json::Value) -> Result<(), String> {
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // Create app data directory if it doesn't exist
    fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;

    // Create the full path for texttospeech.json
    let config_path = app_data_dir.join("texttospeech.json");

    let config_str = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    fs::write(&config_path, config_str)
        .map_err(|e| format!("Failed to write TTS config: {}", e))?;

    log_info!("TTSSettings", "TTS settings saved to {:?}", config_path);
    Ok(())
}

#[tauri::command]
async fn load_tts_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let config_path = app_data_dir.join("texttospeech.json");

    match fs::read_to_string(&config_path) {
        Ok(content) => {
            let config: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse TTS config: {}", e))?;
            Ok(config)
        }
        Err(_) => {
            // Return empty config if file doesn't exist
            Ok(serde_json::json!({}))
        }
    }
}

#[tauri::command]
async fn save_pth_model(
    app: AppHandle,
    file_name: String,
    base64_data: String,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD as Base64Engine, Engine};
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // Create pythonenv/models directory if it doesn't exist
    let model_dir = app_data_dir.join("pythonenv").join("models");
    fs::create_dir_all(&model_dir)
        .map_err(|e| format!("Failed to create model directory: {}", e))?;

    // Decode base64 data
    let file_data = Base64Engine
        .decode(&base64_data)
        .map_err(|e| format!("Failed to decode base64 data: {}", e))?;

    // Save file with original name
    let file_path = model_dir.join(&file_name);
    fs::write(&file_path, file_data).map_err(|e| format!("Failed to write model file: {}", e))?;

    log_info!("ModelManager", "Model file saved: {:?}", file_path);
    Ok(())
}

#[tauri::command]
async fn get_pth_models(app: AppHandle) -> Result<Vec<String>, String> {
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let model_dir = app_data_dir.join("pythonenv").join("models");

    // Check if directory exists
    if !model_dir.exists() {
        return Ok(Vec::new());
    }

    // Read directory contents
    let entries =
        fs::read_dir(&model_dir).map_err(|e| format!("Failed to read models directory: {}", e))?;

    let mut models = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_file() {
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                // Only include .pth files
                if file_name.ends_with(".pth") {
                    models.push(file_name.to_string());
                }
            }
        }
    }

    // Sort models for consistent ordering
    models.sort();
    Ok(models)
}

#[tauri::command]
async fn delete_pth_model(app: AppHandle, file_name: String) -> Result<(), String> {
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let file_path = app_data_dir
        .join("pythonenv")
        .join("models")
        .join(&file_name);

    // Check if file exists
    if !file_path.exists() {
        return Err(format!("Model file does not exist: {}", file_name));
    }

    // Check if it's a .pth file for security
    if !file_name.ends_with(".pth") {
        return Err("Only .pth model files can be deleted".to_string());
    }

    // Delete the file
    fs::remove_file(&file_path).map_err(|e| format!("Failed to delete model file: {}", e))?;

    log_info!("ModelManager", "Model file deleted: {:?}", file_path);
    Ok(())
}

#[tauri::command]
async fn test_tts_normal(provider: String, voice: String) -> Result<(), String> {
    // TODO: Implement normal TTS testing
    log_info!(
        "TTSTest",
        "Testing Normal TTS - Provider: {}, Voice: {}",
        provider,
        voice
    );
    Ok(())
}

#[tauri::command]
async fn test_tts_rvc(
    device: String,
    inference_rate: f64,
    filter_radius: i32,
    resample_rate: f64,
    protect_rate: f64,
) -> Result<(), String> {
    // TODO: Implement RVC TTS testing
    log_info!(
        "TTSTest",
        "Testing RVC TTS - Device: {}, IR: {}, FR: {}, RMR: {}, PR: {}",
        device,
        inference_rate,
        filter_radius,
        resample_rate,
        protect_rate
    );
    Ok(())
}

#[tauri::command]
async fn setup_python_environment(
    app: AppHandle,
    window: Window,
) -> Result<serde_json::Value, String> {
    use std::fs;
    use std::process::Command;

    log_info!(
        "PythonEnvironment",
        "Starting comprehensive Python environment setup..."
    );

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // Step 1: Check if Python is installed and version >= 3.10
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 10,
                "status": "Checking Python installation and version..."
            }),
        )
        .unwrap();
    log_info!(
        "PythonEnvironment",
        "Step 1: Checking Python installation and version..."
    );

    let python_command = if cfg!(windows) { "python" } else { "python3" };

    let python_check = Command::new(python_command)
        .arg("--version")
        .output()
        .map_err(|e| {
            format!(
                "Python not found. Please install Python 3.10 or higher. Error: {}",
                e
            )
        })?;

    if !python_check.status.success() {
        return Err("Python not found. Please install Python 3.10 or higher.".to_string());
    }

    let version_output = String::from_utf8_lossy(&python_check.stdout);
    log_info!(
        "PythonEnvironment",
        "Found Python: {}",
        version_output.trim()
    );

    let version_string = version_output.trim().replace("Python ", "");
    let version_parts: Vec<&str> = version_string.split('.').collect();

    if version_parts.len() >= 2 {
        let major: i32 = version_parts[0].parse().unwrap_or(0);
        let minor: i32 = version_parts[1].parse().unwrap_or(0);

        if major < 3 || (major == 3 && minor < 10) {
            return Err(format!(
                "Python version {}.{} found, but version 3.10 or higher is required.",
                major, minor
            ));
        }
    }

    // Step 2: Create pythonenv directory in app data directory
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 25,
                "status": "Creating pythonenv directory..."
            }),
        )
        .unwrap();
    log_info!(
        "PythonEnvironment",
        "Step 2: Creating pythonenv directory in app data..."
    );

    let pythonenv_dir = app_data_dir.join("pythonenv");
    fs::create_dir_all(&pythonenv_dir)
        .map_err(|e| format!("Failed to create pythonenv directory: {}", e))?;

    // Step 3: Create virtual environment
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 40,
                "status": "Creating Python virtual environment..."
            }),
        )
        .unwrap();
    log_info!(
        "PythonEnvironment",
        "Step 3: Creating Python virtual environment..."
    );

    let venv_creation = Command::new(python_command)
        .args(["-m", "venv", pythonenv_dir.to_str().unwrap()])
        .output()
        .map_err(|e| format!("Failed to create virtual environment: {}", e))?;

    if !venv_creation.status.success() {
        let error_output = String::from_utf8_lossy(&venv_creation.stderr);
        return Err(format!(
            "Failed to create virtual environment: {}",
            error_output
        ));
    }

    // Step 4: Determine pip path based on OS
    let pip_path = if cfg!(windows) {
        pythonenv_dir.join("Scripts").join("pip.exe")
    } else {
        pythonenv_dir.join("bin").join("pip")
    };

    // Step 4: Install edge-tts
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 60,
                "status": "Installing edge-tts package..."
            }),
        )
        .unwrap();
    log_info!("PythonEnvironment", "Step 4: Installing edge-tts...");

    let edge_tts_install = Command::new(&pip_path)
        .args(["install", "edge-tts"])
        .output()
        .map_err(|e| format!("Failed to install edge-tts: {}", e))?;

    if !edge_tts_install.status.success() {
        let error_output = String::from_utf8_lossy(&edge_tts_install.stderr);
        return Err(format!("Failed to install edge-tts: {}", error_output));
    }

    // Step 5: Install PyTorch with CUDA 118 support
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 70,
                "status": "Installing PyTorch with CUDA 118 support..."
            }),
        )
        .unwrap();
    log_info!(
        "PythonEnvironment",
        "Step 5: Installing PyTorch with CUDA 118..."
    );

    // Install torch with specific version and CUDA support
    let torch_install = Command::new(&pip_path)
        .args([
            "install",
            "torch==2.1.1+cu118",
            "--index-url",
            "https://download.pytorch.org/whl/cu118",
        ])
        .output()
        .map_err(|e| format!("Failed to install torch: {}", e))?;

    if !torch_install.status.success() {
        let error_output = String::from_utf8_lossy(&torch_install.stderr);
        return Err(format!("Failed to install torch: {}", error_output));
    }

    // Step 6: Install torchaudio with CUDA 118 support
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 80,
                "status": "Installing torchaudio with CUDA 118 support..."
            }),
        )
        .unwrap();
    log_info!(
        "PythonEnvironment",
        "Step 6: Installing torchaudio with CUDA 118..."
    );

    let torchaudio_install = Command::new(&pip_path)
        .args([
            "install",
            "torchaudio==2.1.1+cu118",
            "--index-url",
            "https://download.pytorch.org/whl/cu118",
        ])
        .output()
        .map_err(|e| format!("Failed to install torchaudio: {}", e))?;

    if !torchaudio_install.status.success() {
        let error_output = String::from_utf8_lossy(&torchaudio_install.stderr);
        return Err(format!("Failed to install torchaudio: {}", error_output));
    }

    // Step 7: Install rvc-python
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 90,
                "status": "Installing rvc-python package..."
            }),
        )
        .unwrap();
    log_info!("PythonEnvironment", "Step 7: Installing rvc-python...");

    let rvc_python_install = Command::new(&pip_path)
        .args(["install", "rvc-python"])
        .output()
        .map_err(|e| format!("Failed to install rvc-python: {}", e))?;

    if !rvc_python_install.status.success() {
        let error_output = String::from_utf8_lossy(&rvc_python_install.stderr);
        return Err(format!("Failed to install rvc-python: {}", error_output));
    }

    // Final step: Complete
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 100,
                "status": "Environment setup completed successfully!"
            }),
        )
        .unwrap();
    log_info!(
        "PythonEnvironment",
        "Python environment setup completed successfully!"
    );

    // Return success status with installed packages
    Ok(serde_json::json!({
        "success": true,
        "python_version": version_output.trim(),
        "virtual_env_path": pythonenv_dir.to_string_lossy(),
        "installed_packages": ["edge-tts", "torch==2.1.1+cu118", "torchaudio==2.1.1+cu118", "rvc-python"],
        "message": "Python environment setup completed successfully!"
    }))
}

#[tauri::command]
async fn check_environment_status(app: AppHandle) -> Result<serde_json::Value, String> {
    use std::path::Path;
    use std::process::Command;

    log_info!("PythonEnvironment", "Checking environment status...");

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // Check if virtual environment exists in app data directory
    let pythonenv_path = app_data_dir.join("pythonenv");
    let env_exists = pythonenv_path.exists();

    if !env_exists {
        return Ok(serde_json::json!({
            "environment_ready": false,
            "python_version": null,
            "library_versions": null,
            "message": "Virtual environment not found"
        }));
    }

    // Check Python version
    let python_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("python.exe")
    } else {
        pythonenv_path.join("bin").join("python")
    };

    let python_version = match Command::new(&python_path).arg("--version").output() {
        Ok(output) => {
            if output.status.success() {
                let version_output = String::from_utf8_lossy(&output.stdout);
                Some(format!("{} (Virtual Environment)", version_output.trim()))
            } else {
                None
            }
        }
        Err(_) => None,
    };

    // Check library versions
    let library_versions = get_library_versions_internal_with_path(&pythonenv_path).await;

    // Check if environment is truly ready - need all required libraries installed
    let environment_ready = if python_version.is_some() && library_versions.is_ok() {
        let libs = library_versions.as_ref().unwrap();
        let required_libs = ["rvc-python", "edge-tts", "torch", "torchaudio"];

        required_libs.iter().all(|&lib| {
            if let Some(version) = libs.get(lib).and_then(|v| v.as_str()) {
                version != "not installed"
            } else {
                false
            }
        })
    } else {
        false
    };

    log_info!(
        "PythonEnvironment",
        "Environment check - Ready: {}, Python: {}, Libraries: {:?}",
        environment_ready,
        python_version.is_some(),
        library_versions.is_ok()
    );

    // Generate informative message
    let message = if environment_ready {
        "Environment is ready".to_string()
    } else if python_version.is_none() {
        "Python virtual environment not found".to_string()
    } else if library_versions.is_err() {
        "Failed to check library versions".to_string()
    } else {
        let libs = library_versions.as_ref().unwrap();
        let required_libs = ["rvc-python", "edge-tts", "torch", "torchaudio"];
        let missing_libs: Vec<&str> = required_libs
            .iter()
            .filter(|&&lib| {
                if let Some(version) = libs.get(lib).and_then(|v| v.as_str()) {
                    version == "not installed"
                } else {
                    true
                }
            })
            .copied()
            .collect();

        if missing_libs.is_empty() {
            "Environment needs setup".to_string()
        } else {
            format!("Missing libraries: {}", missing_libs.join(", "))
        }
    };

    Ok(serde_json::json!({
        "environment_ready": environment_ready,
        "python_version": python_version,
        "library_versions": library_versions.unwrap_or_else(|_| serde_json::json!({})),
        "message": message
    }))
}

async fn get_library_versions_internal_with_path(
    pythonenv_path: &std::path::Path,
) -> Result<serde_json::Value, String> {
    use std::fs;
    use std::process::Command;

    // Check Python version
    let python_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("python.exe")
    } else {
        pythonenv_path.join("bin").join("python")
    };

    if !python_path.exists() {
        return Err("Python executable not found in virtual environment".to_string());
    }

    // Create a temporary Python script to check package versions
    let script_content = r#"
import json, subprocess, sys
def v(p, i):
    r = subprocess.run([sys.executable, "-m", "pip", "show", p], stdout=subprocess.PIPE, text=True)
    for l in r.stdout.splitlines():
        if l.lower().startswith("version:"): return l.split(":",1)[1].strip()
    try:
        return __import__(i).__version__
    except: return "not installed"
print(json.dumps({"rvc-python":v("rvc-python","rvc"),"edge-tts":v("edge-tts","edge_tts"),"torch":v("torch","torch"),"torchaudio":v("torchaudio","torchaudio")}, indent=2))
"#;

    // Write the script to a temporary file in the pythonenv directory
    let temp_script = pythonenv_path.join("check_versions_temp.py");
    fs::write(&temp_script, script_content)
        .map_err(|e| format!("Failed to write temporary script: {}", e))?;

    // Execute the script
    let output = Command::new(&python_path)
        .arg(&temp_script)
        .output()
        .map_err(|e| format!("Failed to execute version check script: {}", e))?;

    // Clean up the temporary file
    let _ = fs::remove_file(&temp_script);

    if output.status.success() {
        let output_str = String::from_utf8_lossy(&output.stdout);
        match serde_json::from_str::<serde_json::Value>(&output_str) {
            Ok(json_value) => Ok(json_value),
            Err(e) => Err(format!("Failed to parse JSON output: {}", e)),
        }
    } else {
        let error_output = String::from_utf8_lossy(&output.stderr);
        Err(format!("Script execution failed: {}", error_output))
    }
}

async fn get_library_versions_internal() -> Result<serde_json::Value, String> {
    use std::fs;
    use std::process::Command;

    // Get the AppData directory
    let data_dir = match dirs::data_dir() {
        Some(dir) => dir,
        None => return Err("Could not determine data directory".to_string()),
    };
    let pythonenv_path = data_dir.join("vocalix-v2").join("pythonenv");

    let python_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("python.exe")
    } else {
        pythonenv_path.join("bin").join("python")
    };

    if !python_path.exists() {
        return Err("Python executable not found in virtual environment".to_string());
    }

    // Create a temporary Python script to check package versions
    let script_content = r#"
import json, subprocess, sys
def v(p, i):
    r = subprocess.run([sys.executable, "-m", "pip", "show", p], stdout=subprocess.PIPE, text=True)
    for l in r.stdout.splitlines():
        if l.lower().startswith("version:"): return l.split(":",1)[1].strip()
    try:
        return __import__(i).__version__
    except: return "not installed"
print(json.dumps({"rvc-python":v("rvc-python","rvc"),"edge-tts":v("edge-tts","edge_tts"),"torch":v("torch","torch"),"torchaudio":v("torchaudio","torchaudio")}, indent=2))
"#;

    // Write the script to a temporary file in the pythonenv directory
    let temp_script = pythonenv_path.join("check_versions_temp.py");
    fs::write(&temp_script, script_content)
        .map_err(|e| format!("Failed to write temporary script: {}", e))?;

    // Execute the script
    let output = Command::new(&python_path)
        .arg(&temp_script)
        .output()
        .map_err(|e| format!("Failed to execute version check script: {}", e))?;

    // Clean up the temporary file
    let _ = fs::remove_file(&temp_script);

    if output.status.success() {
        let output_str = String::from_utf8_lossy(&output.stdout);
        match serde_json::from_str::<serde_json::Value>(&output_str) {
            Ok(json_value) => Ok(json_value),
            Err(e) => Err(format!("Failed to parse JSON output: {}", e)),
        }
    } else {
        let error_output = String::from_utf8_lossy(&output.stderr);
        Err(format!("Script execution failed: {}", error_output))
    }
}

#[tauri::command]
async fn check_python_version(app: AppHandle) -> Result<String, String> {
    use std::process::Command;

    log_info!("PythonEnvironment", "Checking Python version...");

    let python_command = if cfg!(windows) { "python" } else { "python3" };

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // First try using the virtual environment if it exists in app data
    let pythonenv_path = app_data_dir.join("pythonenv");
    let python_path = if pythonenv_path.exists() {
        if cfg!(windows) {
            pythonenv_path.join("Scripts").join("python.exe")
        } else {
            pythonenv_path.join("bin").join("python")
        }
    } else {
        // Fall back to system Python
        std::path::PathBuf::from(python_command)
    };

    // Execute python --version
    let version_check = Command::new(&python_path).arg("--version").output();

    match version_check {
        Ok(output) => {
            if output.status.success() {
                let version_output = String::from_utf8_lossy(&output.stdout);
                let version_str = version_output.trim();
                log_info!("PythonVersion", "Found Python: {}", version_str);

                // Add environment info
                let env_info =
                    if pythonenv_path.exists() && python_path.starts_with(&pythonenv_path) {
                        " (Virtual Environment)"
                    } else {
                        " (System)"
                    };

                Ok(format!("{}{}", version_str, env_info))
            } else {
                // Try system Python if virtual environment failed
                if pythonenv_path.exists() && python_path.starts_with(&pythonenv_path) {
                    log_info!(
                        "PythonVersion",
                        "Virtual environment Python failed, trying system Python..."
                    );

                    let system_check = Command::new(python_command).arg("--version").output();

                    match system_check {
                        Ok(output) => {
                            if output.status.success() {
                                let version_output = String::from_utf8_lossy(&output.stdout);
                                Ok(format!("{} (System)", version_output.trim()))
                            } else {
                                Err("Python version check failed".to_string())
                            }
                        }
                        Err(e) => Err(format!("Failed to execute Python: {}", e)),
                    }
                } else {
                    let error_output = String::from_utf8_lossy(&output.stderr);
                    Err(format!("Python version check failed: {}", error_output))
                }
            }
        }
        Err(e) => {
            // Try system Python if virtual environment failed
            if pythonenv_path.exists() && python_path.starts_with(&pythonenv_path) {
                log_info!(
                    "PythonVersion",
                    "Virtual environment Python failed, trying system Python..."
                );

                let system_check = Command::new(python_command).arg("--version").output();

                match system_check {
                    Ok(output) => {
                        if output.status.success() {
                            let version_output = String::from_utf8_lossy(&output.stdout);
                            Ok(format!("{} (System)", version_output.trim()))
                        } else {
                            Err("System Python version check failed".to_string())
                        }
                    }
                    Err(e) => Err(format!("Python not found: {}", e)),
                }
            } else {
                Err(format!("Failed to execute Python: {}", e))
            }
        }
    }
}

#[tauri::command]
async fn check_library_versions(app: AppHandle) -> Result<serde_json::Value, String> {
    log_info!("PythonEnvironment", "Checking library versions...");

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let pythonenv_path = app_data_dir.join("pythonenv");
    get_library_versions_internal_with_path(&pythonenv_path).await
}

#[tauri::command]
async fn get_available_devices(app: AppHandle) -> Result<serde_json::Value, String> {
    use std::fs;
    use std::process::Command;

    log_info!("PythonEnvironment", "Getting available devices...");

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let pythonenv_path = app_data_dir.join("pythonenv");
    let python_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("python.exe")
    } else {
        pythonenv_path.join("bin").join("python")
    };

    if !python_path.exists() {
        return Err("Python executable not found in virtual environment".to_string());
    }

    // Create a temporary Python script to check available devices
    let script_content = r#"
try:
    import torch
    import json
    devices = []
    for i in range(torch.cuda.device_count()):
        devices.append({'type': 'cuda', 'name': torch.cuda.get_device_name(i)})
    devices.append({'type': 'cpu', 'name': 'CPU'})
    print(json.dumps(devices))
except ImportError:
    import json
    print(json.dumps([{'type': 'cpu', 'name': 'CPU'}]))
"#;

    // Write the script to a temporary file in the pythonenv directory
    let temp_script = pythonenv_path.join("get_devices_temp.py");
    fs::write(&temp_script, script_content)
        .map_err(|e| format!("Failed to write temporary script: {}", e))?;

    // Execute the script
    let output = Command::new(&python_path)
        .arg(&temp_script)
        .output()
        .map_err(|e| format!("Failed to execute device check script: {}", e))?;

    // Clean up the temporary file
    let _ = fs::remove_file(&temp_script);

    if output.status.success() {
        let output_str = String::from_utf8_lossy(&output.stdout);
        match serde_json::from_str::<serde_json::Value>(&output_str) {
            Ok(json_value) => Ok(json_value),
            Err(e) => Err(format!("Failed to parse JSON output: {}", e)),
        }
    } else {
        let error_output = String::from_utf8_lossy(&output.stderr);
        Err(format!("Script execution failed: {}", error_output))
    }
}

#[tauri::command]
async fn install_dependencies() -> Result<(), String> {
    // TODO: Implement dependency installation
    println!("Installing dependencies...");
    Ok(())
}

#[tauri::command]
async fn download_models() -> Result<(), String> {
    // TODO: Implement model downloading
    println!("Downloading models...");
    Ok(())
}

#[tauri::command]
async fn delete_audio_file(
    app: AppHandle,
    redemption_name: String,
    file_name: String,
) -> Result<(), String> {
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let file_path = app_data_dir
        .join("static_audios")
        .join(&redemption_name)
        .join(&file_name);

    // Check if file exists
    if !file_path.exists() {
        return Err(format!("File does not exist: {:?}", file_path));
    }

    // Delete the file
    fs::remove_file(&file_path)
        .map_err(|e| format!("Failed to delete file {:?}: {}", file_path, e))?;

    log_info!("AudioManager", "Deleted audio file: {:?}", file_path);

    // Try to remove directory if it's empty
    let dir_path = app_data_dir.join("static_audios").join(&redemption_name);
    if let Ok(entries) = fs::read_dir(&dir_path) {
        if entries.count() == 0 {
            let _ = fs::remove_dir(&dir_path); // Ignore errors for directory removal
            log_info!("AudioManager", "Removed empty directory: {:?}", dir_path);
        }
    }

    Ok(())
}

// Helper function to handle Twitch EventSub events
async fn handle_twitch_event(
    window: &Window,
    event: EventSubEvent,
) -> Result<(), Box<dyn std::error::Error>> {
    match event {
        EventSubEvent::SessionWelcome(session) => {
            log_info!(
                "TwitchEventSub",
                "WebSocket session established: {}",
                session.id
            );
            window.emit("STATUS_UPDATE", "WebSocket session established")?;
        }

        EventSubEvent::SessionReconnect(session) => {
            log_info!(
                "TwitchEventSub",
                "Reconnecting to new session: {}",
                session.id
            );
            window.emit("STATUS_UPDATE", "Reconnecting to new session...")?;
        }

        EventSubEvent::Notification {
            subscription_type,
            event,
            ..
        } => {
            log_info!(
                "TwitchEventSub",
                "Received notification: {}",
                subscription_type
            );

            match subscription_type.as_str() {
                "channel.channel_points_custom_reward_redemption.add" => {
                    match parse_channel_points_redemption(&event) {
                        Ok(redemption) => {
                            log_info!(
                                "TwitchEventSub",
                                "Channel points redemption: {} redeemed '{}' for {} points",
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
                            log_error!(
                                "TwitchEventSub",
                                "Failed to parse channel points redemption: {}",
                                e
                            );
                        }
                    }
                }
                _ => {
                    log_debug!(
                        "TwitchEventSub",
                        "Unhandled event type: {}",
                        subscription_type
                    );
                    // Forward other events as generic events
                    let event_data = serde_json::json!({
                        "type": subscription_type,
                        "data": event
                    });
                    window.emit("TWITCH_EVENT", event_data)?;
                }
            }
        }

        EventSubEvent::Revocation {
            subscription_type, ..
        } => {
            log_warn!(
                "TwitchEventSub",
                "Subscription revoked: {}",
                subscription_type
            );
            window.emit(
                "ERROR",
                format!("Subscription revoked: {}", subscription_type),
            )?;
        }

        EventSubEvent::Keepalive => {
            // Keepalive messages don't need special handling
        }

        EventSubEvent::ConnectionStateChanged(state) => {
            log_info!("TwitchEventSub", "Connection state changed: {:?}", state);
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
            log_error!("TwitchEventSub", "EventSub error: {}", error);
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
    let role = if is_initiator {
        "INITIATOR"
    } else {
        "LISTENER"
    };
    log_and_emit(
        &window,
        role,
        "CONNECTION_START",
        "Starting secure connection handler",
    )
    .await;

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
            Ok(serialized) => match encrypt_message(keys, &serialized).await {
                Ok((ciphertext, nonce)) => {
                    println!("[REDEMPTION] Encrypted redemption message: type {}, {} bytes audio -> {} bytes ciphertext", 
                            message_type, audio_len, ciphertext.len());
                    let msg = Message::EncryptedMessage { ciphertext, nonce };
                    send_message(stream, &msg).await;
                }
                Err(e) => {
                    eprintln!(
                        "[REDEMPTION_ERROR] Failed to encrypt redemption message: {}",
                        e
                    );
                }
            },
            Err(e) => {
                eprintln!(
                    "[REDEMPTION_ERROR] Failed to serialize redemption message: {}",
                    e
                );
            }
        }
    }
}

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

#[tauri::command]
async fn force_reinstall_libraries(
    app: AppHandle,
    window: tauri::Window,
) -> Result<String, String> {
    use std::process::Command;

    log_info!(
        "PythonEnvironment",
        "Force reinstalling Python libraries..."
    );

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let pythonenv_path = app_data_dir.join("pythonenv");

    if !pythonenv_path.exists() {
        return Err(
            "Virtual environment not found. Please set up the environment first.".to_string(),
        );
    }

    // Determine pip path
    let pip_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("pip.exe")
    } else {
        pythonenv_path.join("bin").join("pip")
    };

    // Emit progress updates
    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 10,
            "status": "Uninstalling existing packages..."
        }),
    );

    // Uninstall existing packages
    let packages = ["edge-tts", "rvc-python"];
    for (i, package) in packages.iter().enumerate() {
        let progress = 10 + (i as i32 * 20);
        let _ = window.emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": progress,
                "status": format!("Uninstalling {}...", package)
            }),
        );

        let uninstall_result = Command::new(&pip_path)
            .args(["uninstall", package, "-y"])
            .output();

        if let Err(e) = uninstall_result {
            log_warn!(
                "PythonEnvironment",
                "Failed to uninstall {}: {}",
                package,
                e
            );
        }
    }

    // Clear pip cache
    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 50,
            "status": "Clearing pip cache..."
        }),
    );

    let _ = Command::new(&pip_path).args(["cache", "purge"]).output();

    // Reinstall packages
    for (i, package) in packages.iter().enumerate() {
        let progress = 60 + (i as i32 * 20);
        let _ = window.emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": progress,
                "status": format!("Installing {}...", package)
            }),
        );

        let install_result = Command::new(&pip_path)
            .args(["install", "--force-reinstall", "--no-cache-dir", package])
            .output();

        match install_result {
            Ok(output) => {
                if !output.status.success() {
                    let error_output = String::from_utf8_lossy(&output.stderr);
                    return Err(format!("Failed to install {}: {}", package, error_output));
                }
            }
            Err(e) => {
                return Err(format!(
                    "Failed to execute pip install for {}: {}",
                    package, e
                ));
            }
        }
    }

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 100,
            "status": "Force reinstall completed successfully!"
        }),
    );

    Ok("Libraries force-reinstalled successfully".to_string())
}

#[tauri::command]
async fn reset_python_environment(app: AppHandle, window: tauri::Window) -> Result<String, String> {
    use std::fs;
    use std::process::Command;

    log_info!("PythonEnvironment", "Resetting Python environment...");

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let pythonenv_path = app_data_dir.join("pythonenv");

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 10,
            "status": "Removing existing virtual environment..."
        }),
    );

    // Remove existing virtual environment
    if pythonenv_path.exists() {
        if let Err(e) = fs::remove_dir_all(&pythonenv_path) {
            return Err(format!("Failed to remove existing environment: {}", e));
        }
    }

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 30,
            "status": "Creating fresh virtual environment..."
        }),
    );

    // Create fresh virtual environment
    let python_command = if cfg!(windows) { "python" } else { "python3" };
    let venv_result = Command::new(python_command)
        .args(["-m", "venv", pythonenv_path.to_str().unwrap()])
        .output();

    match venv_result {
        Ok(output) => {
            if !output.status.success() {
                let error_output = String::from_utf8_lossy(&output.stderr);
                return Err(format!(
                    "Failed to create virtual environment: {}",
                    error_output
                ));
            }
        }
        Err(e) => {
            return Err(format!("Failed to execute venv command: {}", e));
        }
    }

    // Set up pip path for package installation
    let pip_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("pip.exe")
    } else {
        pythonenv_path.join("bin").join("pip")
    };

    // Install required packages
    let packages = ["edge-tts", "rvc-python"];
    for (i, package) in packages.iter().enumerate() {
        let progress = 60 + (i as i32 * 20);
        let _ = window.emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": progress,
                "status": format!("Installing {}...", package)
            }),
        );

        let install_result = Command::new(&pip_path).args(["install", package]).output();

        match install_result {
            Ok(output) => {
                if !output.status.success() {
                    let error_output = String::from_utf8_lossy(&output.stderr);
                    return Err(format!("Failed to install {}: {}", package, error_output));
                }
            }
            Err(e) => {
                return Err(format!(
                    "Failed to execute pip install for {}: {}",
                    package, e
                ));
            }
        }
    }

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 100,
            "status": "Environment reset completed successfully!"
        }),
    );

    Ok("Python environment reset successfully".to_string())
}

// === LOGGING COMMANDS ===

#[tauri::command]
async fn write_log(
    level: String,
    component: String,
    message: String,
    timestamp: String,
    logging_state: State<'_, LoggingState>,
) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io::Write;

    let log_entry = LogEntry {
        timestamp,
        level,
        component,
        message,
    };

    let log_file_path = logging_state
        .log_file_path
        .lock()
        .map_err(|e| format!("Failed to lock log file path: {}", e))?;

    // Create log line
    let log_line = format!(
        "[{}] [{}] [{}] {}\n",
        log_entry.timestamp,
        log_entry.level.to_uppercase(),
        log_entry.component,
        log_entry.message
    );

    // Write to file
    match OpenOptions::new()
        .create(true)
        .append(true)
        .open(&*log_file_path)
    {
        Ok(mut file) => {
            if let Err(e) = file.write_all(log_line.as_bytes()) {
                eprintln!("Failed to write log to file: {}", e);
                return Err(format!("Failed to write log: {}", e));
            }
            if let Err(e) = file.flush() {
                eprintln!("Failed to flush log file: {}", e);
            }
        }
        Err(e) => {
            eprintln!("Failed to open log file: {}", e);
            return Err(format!("Failed to open log file: {}", e));
        }
    }

    Ok(())
}

#[tauri::command]
async fn get_logs(logging_state: State<'_, LoggingState>) -> Result<Vec<LogEntry>, String> {
    use std::fs;
    use std::io::{BufRead, BufReader};

    let log_file_path = logging_state
        .log_file_path
        .lock()
        .map_err(|e| format!("Failed to lock log file path: {}", e))?;

    match fs::File::open(&*log_file_path) {
        Ok(file) => {
            let reader = BufReader::new(file);
            let mut logs = Vec::new();

            for line in reader.lines() {
                if let Ok(line) = line {
                    if let Some(log_entry) = parse_log_line(&line) {
                        logs.push(log_entry);
                    }
                }
            }

            // Return the last 1000 entries
            if logs.len() > 1000 {
                let start = logs.len() - 1000;
                logs.drain(0..start);
            }

            Ok(logs)
        }
        Err(_) => {
            // Return empty vec if file doesn't exist
            Ok(Vec::new())
        }
    }
}

#[tauri::command]
async fn clear_logs(logging_state: State<'_, LoggingState>) -> Result<(), String> {
    use std::fs;

    let log_file_path = logging_state
        .log_file_path
        .lock()
        .map_err(|e| format!("Failed to lock log file path: {}", e))?;

    match fs::write(&*log_file_path, "") {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Failed to clear log file: {}", e)),
    }
}

// Helper function to parse log lines
fn parse_log_line(line: &str) -> Option<LogEntry> {
    // Parse format: [timestamp] [LEVEL] [component] message
    if line.len() < 10 || !line.starts_with('[') {
        return None;
    }

    let parts: Vec<&str> = line.splitn(4, ']').collect();
    if parts.len() != 4 {
        return None;
    }

    let timestamp = parts[0].trim_start_matches('[').to_string();
    let level = parts[1].trim_start_matches(" [").to_lowercase();
    let component = parts[2].trim_start_matches(" [").to_string();
    let message = parts[3].trim_start_matches(' ').to_string();

    Some(LogEntry {
        timestamp,
        level,
        component,
        message,
    })
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

    // Initialize logging state
    let logging_state = LoggingState {
        log_file_path: Arc::new(std::sync::Mutex::new("logs/vocalix.log".to_string())),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(app_state)
        .manage(twitch_state)
        .manage(logging_state)
        .setup(|app| {
            // Get app data directory and create logs directory
            if let Ok(app_data_dir) = app.path().app_data_dir() {
                let logs_dir = app_data_dir.join("logs");
                if let Err(e) = std::fs::create_dir_all(&logs_dir) {
                    eprintln!("Failed to create logs directory {:?}: {}", logs_dir, e);
                } else {
                    // Update the logging state with the correct path
                    let log_file_path = logs_dir.join("vocalix.log");
                    if let Some(logging_state) = app.try_state::<LoggingState>() {
                        if let Ok(mut path) = logging_state.log_file_path.lock() {
                            *path = log_file_path.to_string_lossy().to_string();
                        }
                    }
                }
            } else {
                eprintln!("Failed to get app data directory, using relative logs path");
                if let Err(e) = std::fs::create_dir_all("logs") {
                    eprintln!("Failed to create logs directory: {}", e);
                }
            }
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
            twitch_stop_event_listener,
            twitch_get_user_info,
            twitch_sign_out,
            twitch_is_authenticated,
            twitch_save_credentials,
            twitch_load_credentials,
            twitch_has_saved_credentials,
            twitch_delete_credentials,
            twitch_get_auth_status,
            get_twitch_redemptions,
            save_audio_file,
            get_audio_files,
            delete_audio_file,
            save_tts_settings,
            load_tts_settings,
            save_pth_model,
            get_pth_models,
            delete_pth_model,
            test_tts_normal,
            test_tts_rvc,
            setup_python_environment,
            check_environment_status,
            check_python_version,
            check_library_versions,
            get_available_devices,
            force_reinstall_libraries,
            reset_python_environment,
            install_dependencies,
            download_models,
            // Logging commands
            write_log,
            get_logs,
            clear_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
