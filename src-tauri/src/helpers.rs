use crate::services::twitch::{parse_channel_points_redemption, EventSubEvent};
use crate::{log_debug, log_error, log_info, log_warn};
use tauri::{Emitter, Window, Manager};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri_plugin_store::StoreExt;

#[derive(Debug, Deserialize, Serialize)]
struct RedemptionConfig {
    enabled: bool,
    #[serde(rename = "ttsType")]
    tts_type: String,
    #[serde(rename = "dynamicTemplate")]
    dynamic_template: Option<String>,
    #[serde(rename = "staticFiles")]
    static_files: Option<Vec<Value>>,
    #[serde(rename = "timerEnabled")]
    timer_enabled: Option<bool>,
    #[serde(rename = "timerDuration")]
    timer_duration: Option<String>,
}

fn is_redemption_allowed(redemption_id: &str, window: &Window) -> bool {
    let app = window.app_handle();
    
    match app.store("redemptions.json") {
        Ok(store) => {
            if let Some(redemption_configs_value) = store.get("redemptionConfigs") {
                if let Some(redemption_configs) = redemption_configs_value.as_object() {
                    if let Some(config_value) = redemption_configs.get(redemption_id) {
                        if let Ok(config) = serde_json::from_value::<RedemptionConfig>(config_value.clone()) {
                            log_info!(
                                "RedemptionFilter",
                                "Redemption {} is configured and enabled: {}",
                                redemption_id,
                                config.enabled
                            );
                            return config.enabled;
                        } else {
                            log_warn!(
                                "RedemptionFilter",
                                "Failed to parse config for redemption {}",
                                redemption_id
                            );
                        }
                    } else {
                        log_info!(
                            "RedemptionFilter",
                            "Redemption {} not found in configurations, blocking",
                            redemption_id
                        );
                        return false;
                    }
                } else {
                    log_warn!("RedemptionFilter", "redemptionConfigs is not an object");
                }
            } else {
                log_warn!("RedemptionFilter", "No redemptionConfigs found in store");
            }
        }
        Err(e) => {
            log_error!("RedemptionFilter", "Failed to access store: {}", e);
        }
    }
    
    log_info!(
        "RedemptionFilter",
        "Blocking redemption {} due to missing or invalid configuration",
        redemption_id
    );
    false
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    log_info!("URLHandler", "Attempting to open URL: {}", url);

    #[cfg(target_os = "windows")]
    {
        create_hidden_command("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("Failed to open URL on Windows: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        create_hidden_command("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL on macOS: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
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
            if let Ok(mut child) = create_hidden_command(cmd)
                .arg(&url)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
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

pub async fn handle_twitch_event(
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
                            if !is_redemption_allowed(&redemption.reward.id, window) {
                                log_info!(
                                    "TwitchEventSub",
                                    "Redemption '{}' (ID: {}) by {} is not enabled in configurations, skipping",
                                    redemption.reward.title,
                                    redemption.reward.id,
                                    redemption.user_name
                                );
                                return Ok(());
                            }

                            log_info!(
                                "TwitchEventSub",
                                "Channel points redemption: {} redeemed '{}' (ID: {}) for {} points",
                                redemption.user_name,
                                redemption.reward.title,
                                redemption.reward.id,
                                redemption.reward.cost
                            );

                            let redemption_data = serde_json::json!({
                                "id": redemption.id,
                                "user_name": redemption.user_name,
                                "user_input": redemption.user_input,
                                "reward_title": redemption.reward.title,
                                "reward_id": redemption.reward.id,
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

        EventSubEvent::Keepalive => {}

        EventSubEvent::ConnectionStateChanged(state) => {
            log_info!("TwitchEventSub", "Connection state changed: {:?}", state);
            let status = match state {
                crate::services::twitch::EventSubConnectionState::Connecting => {
                    "Connecting to Twitch..."
                }
                crate::services::twitch::EventSubConnectionState::Connected => {
                    "Connected to Twitch"
                }
                crate::services::twitch::EventSubConnectionState::Reconnecting => "Reconnecting...",
                crate::services::twitch::EventSubConnectionState::Disconnected => {
                    "Disconnected from Twitch"
                }
                crate::services::twitch::EventSubConnectionState::Failed => "Connection failed",
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

pub fn create_hidden_command<P: AsRef<std::ffi::OsStr>>(program: P) -> std::process::Command {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new(program);
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new(program)
    }
}
