// src-tauri/src/twitch.rs - Updated to follow official documentation patterns

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Emitter, State, Window};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, mpsc};
use twitch_api::{
    eventsub::{self}, 
    HelixClient, TwitchClient,
    types as twitch_types
};
use twitch_oauth2::{
    ClientId, ClientSecret, TwitchToken, UserToken, UserTokenBuilder, 
    Scope
};
use url::Url;

// --- Twitch Integration State ---
#[derive(Clone)]
pub struct TwitchState {
    pub token: Arc<Mutex<Option<UserToken>>>,
    pub websocket_url: Option<Url>,
    pub session_id: Arc<Mutex<Option<String>>>,
    pub redemption_tx: Arc<Mutex<Option<mpsc::UnboundedSender<TwitchRedemption>>>>,
}

impl Default for TwitchState {
    fn default() -> Self {
        Self {
            token: Arc::new(Mutex::new(None)),
            websocket_url: None,
            session_id: Arc::new(Mutex::new(None)),
            redemption_tx: Arc::new(Mutex::new(None)),
        }
    }
}

// --- Data Structures ---
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchRedemption {
    pub id: String,
    pub user_id: String,
    pub user_login: String,
    pub user_name: String,
    pub reward_id: String,
    pub reward_title: String,
    pub reward_cost: i64,
    pub reward_prompt: String,
    pub user_input: String,
    pub status: String,
    pub redeemed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchConfig {
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
    pub scope: Vec<String>,
}

// --- OAuth2 Flow Functions ---

/// Start the OAuth2 flow by generating the authorization URL
#[tauri::command]
pub async fn start_twitch_oauth(
    window: Window,
) -> Result<String, String> {
    // Use environment variables or default values
    let client_id = std::env::var("TWITCH_CLIENT_ID")
        .unwrap_or_else(|_| "your_client_id_here".to_string());
    let client_secret = std::env::var("TWITCH_CLIENT_SECRET")
        .unwrap_or_else(|_| "your_client_secret_here".to_string());
    let redirect_uri = "http://localhost:3000/auth/callback";
    
    let client_id = ClientId::new(client_id);
    let client_secret = ClientSecret::new(client_secret);
    let redirect_url = Url::parse(redirect_uri)
        .map_err(|e| format!("Invalid redirect URI: {}", e))?;
    
    // Create user token builder with required scopes for channel points redemptions
    let mut token_builder = UserTokenBuilder::new(
        client_id,
        client_secret,
        redirect_url,
    )
    .set_scopes(vec![
        Scope::ChannelReadRedemptions,
        Scope::ChannelManageRedemptions,
    ]);
    
    let (auth_url, _csrf_token) = token_builder.generate_url();
    
    window.emit("TWITCH_AUTH_URL_GENERATED", auth_url.as_str())
        .map_err(|e| format!("Failed to emit auth URL: {}", e))?;
    
    Ok(auth_url.to_string())
}

/// Handle the OAuth2 callback by extracting the authorization code
#[tauri::command]
pub async fn handle_oauth_callback(
    state: String,
    code: String,
    state_obj: State<'_, TwitchState>,
    window: Window,
) -> Result<AuthResponse, String> {
    // Use environment variables or default values
    let client_id = std::env::var("TWITCH_CLIENT_ID")
        .unwrap_or_else(|_| "your_client_id_here".to_string());
    let client_secret = std::env::var("TWITCH_CLIENT_SECRET")
        .unwrap_or_else(|_| "your_client_secret_here".to_string());
    let redirect_uri = "http://localhost:3000/auth/callback";
    
    let client_id = ClientId::new(client_id);
    let client_secret = ClientSecret::new(client_secret);
    let redirect_url = Url::parse(redirect_uri)
        .map_err(|e| format!("Invalid redirect URI: {}", e))?;
    
    // Create token builder and exchange code for token
    let mut token_builder = UserTokenBuilder::new(
        client_id,
        client_secret,
        redirect_url,
    )
    .set_scopes(vec![
        Scope::ChannelReadRedemptions,
        Scope::ChannelManageRedemptions,
    ]);
    
    // Create a TwitchClient for token exchange
    let http_client = reqwest::Client::new();
    let twitch_client = TwitchClient::with_client(http_client);
    let token = token_builder.get_user_token(&twitch_client, &state, &code)
        .await
        .map_err(|e| format!("Failed to exchange code for token: {}", e))?;
    
    let auth_response = AuthResponse {
        access_token: token.access_token.secret().to_string(),
        refresh_token: token.refresh_token.as_ref().map(|t| t.secret().to_string()),
        expires_in: token.expires_in().as_secs(),
        scope: token.scopes().iter().map(|s| s.as_str().to_string()).collect(),
    };
    
    // Store the token
    {
        let mut token_guard = state_obj.token.lock().await;
        *token_guard = Some(token);
    }
    
    window.emit("TWITCH_TOKEN_OBTAINED", &auth_response)
        .map_err(|e| format!("Failed to emit token obtained event: {}", e))?;
    
    Ok(auth_response)
}

/// Create a temporary HTTP server to handle the OAuth callback
#[tauri::command]
pub async fn start_oauth_callback_server(
    port: u16,
    window: Window,
) -> Result<(), String> {
    let listener = TcpListener::bind(format!("127.0.0.1:{}", port))
        .await
        .map_err(|e| format!("Failed to bind to port {}: {}", port, e))?;
    
    window.emit("OAUTH_SERVER_STARTED", format!("http://127.0.0.1:{}", port))
        .map_err(|e| format!("Failed to emit server started event: {}", e))?;
    
    tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            // Simple HTTP server to handle one request
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            
            let mut stream = stream;
            let mut buffer = [0; 1024];
            
            if let Ok(n) = stream.read(&mut buffer).await {
                let request = String::from_utf8_lossy(&buffer[..n]);
                
                // Parse the request line to get the URL
                if let Some(first_line) = request.lines().next() {
                    if let Some(path) = first_line.split_whitespace().nth(1) {
                        let full_url = format!("http://127.0.0.1:{}{}", port, path);
                        
                        // Send success response
                        let response = "HTTP/1.1 200 OK\r\n\r\n<html><body><h1>Authorization successful!</h1><p>You can close this window.</p><script>window.close();</script></body></html>";
                        let _ = stream.write_all(response.as_bytes()).await;
                        
                        // Emit the callback URL to the frontend
                        let _ = window.emit("OAUTH_CALLBACK_RECEIVED", full_url);
                    }
                }
            }
        }
    });
    
    Ok(())
}

/// Connect to Twitch EventSub WebSocket
#[tauri::command]
pub async fn connect_twitch_eventsub(
    state: State<'_, TwitchState>,
    window: Window,
) -> Result<(), String> {
    let token_guard = state.token.lock().await;
    let token = token_guard.as_ref()
        .ok_or_else(|| "No Twitch token available".to_string())?
        .clone();
    let user_id = token.user_id()
        .ok_or_else(|| "Token does not have user ID".to_string())?
        .to_owned();
    drop(token_guard);
    
    // Create message channel for redemptions
    let (redemption_tx, mut redemption_rx) = mpsc::unbounded_channel::<TwitchRedemption>();
    
    // Store the sender in state
    {
        let mut tx_guard = state.redemption_tx.lock().await;
        *tx_guard = Some(redemption_tx);
    }
    
    let session_id = state.session_id.clone();
    let window_clone = window.clone();
    
    // Spawn WebSocket connection handler
    tokio::spawn(async move {
        if let Err(e) = handle_eventsub_websocket(token, user_id, session_id, window_clone).await {
            eprintln!("EventSub WebSocket error: {}", e);
        }
    });
    
    // Spawn redemption handler
    let window_clone = window.clone();
    tokio::spawn(async move {
        while let Some(redemption) = redemption_rx.recv().await {
            if let Err(e) = window_clone.emit("TWITCH_REDEMPTION", &redemption) {
                eprintln!("Failed to emit redemption: {}", e);
            }
        }
    });
    
    window.emit("TWITCH_EVENTSUB_CONNECTING", ())
        .map_err(|e| format!("Failed to emit connecting event: {}", e))?;
    
    Ok(())
}

/// Handle EventSub WebSocket connection
async fn handle_eventsub_websocket(
    _token: UserToken,
    _user_id: twitch_types::UserId,
    session_id: Arc<Mutex<Option<String>>>,
    window: Window,
) -> Result<()> {
    use tokio_tungstenite::{connect_async, tungstenite::Message};
    use futures_util::StreamExt;
    
    let websocket_url = "wss://eventsub.wss.twitch.tv/ws";
    
    let (ws_stream, _) = connect_async(websocket_url)
        .await
        .context("Failed to connect to EventSub WebSocket")?;
    
    let (_write, mut read) = ws_stream.split();
    
    window.emit("TWITCH_EVENTSUB_CONNECTED", ())
        .map_err(|e| anyhow::anyhow!("Failed to emit connected event: {}", e))?;
    
    while let Some(msg) = read.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if let Err(e) = handle_eventsub_message(&session_id, &window, &text).await {
                    eprintln!("Error handling EventSub message: {}", e);
                }
            }
            Ok(Message::Close(_)) => {
                window.emit("TWITCH_EVENTSUB_DISCONNECTED", ())
                    .map_err(|e| anyhow::anyhow!("Failed to emit disconnected event: {}", e))?;
                break;
            }
            Err(e) => {
                eprintln!("WebSocket error: {}", e);
                break;
            }
            _ => {}
        }
    }
    
    Ok(())
}

/// Handle individual EventSub messages
async fn handle_eventsub_message(
    session_id: &Arc<Mutex<Option<String>>>,
    window: &Window,
    message: &str,
) -> Result<()> {
    use twitch_api::eventsub::{Event, event::websocket::EventsubWebsocketData};
    
    let event = Event::parse_websocket(message)
        .context("Failed to parse EventSub message")?;
    
    match event {
        EventsubWebsocketData::Welcome { payload, .. } => {
            // Store session ID
            {
                let mut session_guard = session_id.lock().await;
                *session_guard = Some(payload.session.id.to_string());
            }
            
            window.emit("TWITCH_EVENTSUB_WELCOME", payload.session.id.as_ref())
                .map_err(|e| anyhow::anyhow!("Failed to emit welcome event: {}", e))?;
        }
        
        EventsubWebsocketData::Notification { payload, .. } => {
            match payload {
                Event::ChannelPointsCustomRewardRedemptionAddV1(redemption_event) => {
                    if let eventsub::Message::Notification(notification) = redemption_event.message {
                        let redemption = TwitchRedemption {
                            id: notification.id.to_string(),
                            user_id: notification.user_id.to_string(),
                            user_login: notification.user_login.to_string(),
                            user_name: notification.user_name.to_string(),
                            reward_id: notification.reward.id.to_string(),
                            reward_title: notification.reward.title.clone(),
                            reward_cost: notification.reward.cost,
                            reward_prompt: notification.reward.prompt.clone(),
                            user_input: notification.user_input.clone(),
                            status: format!("{:?}", notification.status),
                            redeemed_at: notification.redeemed_at.to_string(),
                        };
                        
                        window.emit("TWITCH_REDEMPTION", &redemption)
                            .map_err(|e| anyhow::anyhow!("Failed to emit redemption: {}", e))?;
                    }
                }
                _ => {
                    // Handle other event types if needed
                }
            }
        }
        
        EventsubWebsocketData::Keepalive { .. } => {
            // Handle keepalive messages
            window.emit("TWITCH_EVENTSUB_KEEPALIVE", ())
                .map_err(|e| anyhow::anyhow!("Failed to emit keepalive event: {}", e))?;
        }
        
        EventsubWebsocketData::Reconnect { payload, .. } => {
            // Handle reconnect messages
            if let Some(reconnect_url) = payload.session.reconnect_url {
                window.emit("TWITCH_EVENTSUB_RECONNECT", reconnect_url.as_ref())
                    .map_err(|e| anyhow::anyhow!("Failed to emit reconnect event: {}", e))?;
            }
        }
        
        EventsubWebsocketData::Revocation { .. } => {
            // Handle revocation messages
            window.emit("TWITCH_EVENTSUB_REVOKED", ())
                .map_err(|e| anyhow::anyhow!("Failed to emit revoked event: {}", e))?;
        }
        
        _ => {
            // Handle other message types
        }
    }
    
    Ok(())
}

/// Check if we have a valid Twitch token
#[tauri::command]
pub async fn check_twitch_token(state: State<'_, TwitchState>) -> Result<bool, String> {
    let token_guard = state.token.lock().await;
    
    if let Some(token) = token_guard.as_ref() {
        Ok(!token.is_elapsed())
    } else {
        Ok(false)
    }
}

/// Refresh the Twitch token
#[tauri::command]
pub async fn refresh_twitch_token(state: State<'_, TwitchState>) -> Result<AuthResponse, String> {
    let mut token_guard = state.token.lock().await;
    
    if let Some(token) = token_guard.as_mut() {
        let http_client = reqwest::Client::new();
        let twitch_client = TwitchClient::with_client(http_client);
        token.refresh_token(&twitch_client)
            .await
            .map_err(|e| format!("Failed to refresh token: {}", e))?;
        
        Ok(AuthResponse {
            access_token: token.access_token.secret().to_string(),
            refresh_token: token.refresh_token.as_ref().map(|t| t.secret().to_string()),
            expires_in: token.expires_in().as_secs(),
            scope: token.scopes().iter().map(|s| s.as_str().to_string()).collect(),
        })
    } else {
        Err("No token available to refresh".to_string())
    }
}

/// Get current user info from Twitch
#[tauri::command]
pub async fn get_twitch_user_info(state: State<'_, TwitchState>) -> Result<serde_json::Value, String> {
    let token_guard = state.token.lock().await;
    
    if let Some(token) = token_guard.as_ref() {
        let http_client = reqwest::Client::new();
        let client = HelixClient::with_client(http_client);
        
        let user_info = client.get_user_from_id(token.user_id().unwrap(), token)
            .await
            .map_err(|e| format!("Failed to get user info: {}", e))?;
        
        Ok(serde_json::to_value(user_info).unwrap())
    } else {
        Err("No token available".to_string())
    }
}

/// Disconnect from Twitch EventSub
#[tauri::command]
pub async fn disconnect_twitch_eventsub(
    state: State<'_, TwitchState>,
    window: Window,
) -> Result<(), String> {
    // Clear session ID
    {
        let mut session_guard = state.session_id.lock().await;
        *session_guard = None;
    }
    
    // Clear redemption sender
    {
        let mut tx_guard = state.redemption_tx.lock().await;
        *tx_guard = None;
    }
    
    window.emit("TWITCH_EVENTSUB_DISCONNECTED", ())
        .map_err(|e| format!("Failed to emit disconnected event: {}", e))?;
    
    Ok(())
}
