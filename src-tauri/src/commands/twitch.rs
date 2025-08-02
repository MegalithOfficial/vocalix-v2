use crate::helpers::handle_twitch_event;
use crate::{log_error, log_info};
use crate::state::TwitchState;
use crate::services::twitch::{create_common_subscriptions, TwitchEventSub};
use crate::services::twitch_oauth::TwitchAuthManager;
use serde::{Deserialize, Serialize};
use tauri::{State, Window, Emitter};

#[tauri::command]
pub async fn twitch_authenticate(
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
pub async fn twitch_start_event_listener(
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
pub async fn twitch_stop_event_listener(twitch_state: State<'_, TwitchState>) -> Result<(), String> {
    // Clear the EventSub instance
    *twitch_state.event_sub.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn twitch_get_user_info(
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
pub async fn twitch_sign_out(
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
pub async fn twitch_is_authenticated(twitch_state: State<'_, TwitchState>) -> Result<bool, String> {
    let auth_manager_exists = twitch_state.auth_manager.lock().await.is_some();
    Ok(auth_manager_exists && TwitchAuthManager::is_authenticated())
}

#[tauri::command]
pub async fn twitch_save_credentials(
    client_id: String,
    client_secret: Option<String>,
) -> Result<(), String> {
    TwitchAuthManager::save_client_credentials(&client_id, client_secret.as_deref())
        .map_err(|e| format!("Failed to save credentials: {}", e))
}

#[tauri::command]
pub async fn twitch_load_credentials() -> Result<(String, Option<String>), String> {
    TwitchAuthManager::load_client_credentials()
        .map_err(|e| format!("Failed to load credentials: {}", e))
}

#[tauri::command]
pub async fn twitch_has_saved_credentials() -> bool {
    TwitchAuthManager::has_saved_credentials()
}

#[tauri::command]
pub async fn twitch_delete_credentials() -> Result<(), String> {
    TwitchAuthManager::delete_client_credentials()
        .map_err(|e| format!("Failed to delete credentials: {}", e))
}

#[tauri::command]
pub async fn twitch_get_auth_status(twitch_state: State<'_, TwitchState>) -> Result<String, String> {
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
            crate::services::twitch_oauth::AuthStatus::NotAuthenticated => Ok("not_authenticated".to_string()),
            crate::services::twitch_oauth::AuthStatus::Invalid => Ok("invalid".to_string()),
            crate::services::twitch_oauth::AuthStatus::Valid => Ok("valid".to_string()),
            crate::services::twitch_oauth::AuthStatus::ExpiringSoon(_) => Ok("expiring_soon".to_string()),
        },
        Err(e) => Err(format!("Failed to get auth status: {}", e)),
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TwitchRedemption {
    pub id: String,
    pub title: String,
    pub cost: i32,
    pub enabled: bool,
    pub is_enabled: bool,
    pub prompt: Option<String>,
}

#[tauri::command]
pub async fn get_twitch_redemptions(
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
