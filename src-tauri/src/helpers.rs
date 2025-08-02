use crate::{log_debug, log_error, log_info, log_warn};
use crate::services::twitch::{parse_channel_points_redemption, EventSubEvent};
use tauri::{Window, Emitter};

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    log_info!("URLHandler", "Attempting to open URL: {}", url);

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url]) 
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

        EventSubEvent::Keepalive => { }

        EventSubEvent::ConnectionStateChanged(state) => {
            log_info!("TwitchEventSub", "Connection state changed: {:?}", state);
            let status = match state {
                crate::services::twitch::EventSubConnectionState::Connecting => "Connecting to Twitch...",
                crate::services::twitch::EventSubConnectionState::Connected => "Connected to Twitch",
                crate::services::twitch::EventSubConnectionState::Reconnecting => "Reconnecting...",
                crate::services::twitch::EventSubConnectionState::Disconnected => "Disconnected from Twitch",
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
