use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use reqwest;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use tracing::{debug, error, info, instrument, warn};
use url::Url;

const EVENTSUB_WEBSOCKET_URL: &str = "wss://eventsub.wss.twitch.tv/ws";

const DEFAULT_KEEPALIVE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RECONNECT_ATTEMPTS: usize = 5;

const CLOSE_CODE_INTERNAL_SERVER_ERROR: u16 = 4000;
const CLOSE_CODE_CLIENT_SENT_INBOUND_TRAFFIC: u16 = 4001;
const CLOSE_CODE_CLIENT_FAILED_PING_PONG: u16 = 4002;
const CLOSE_CODE_CONNECTION_UNUSED: u16 = 4003;
const CLOSE_CODE_RECONNECT_GRACE_TIME_EXPIRED: u16 = 4004;
const CLOSE_CODE_NETWORK_TIMEOUT: u16 = 4005;
const CLOSE_CODE_NETWORK_ERROR: u16 = 4006;
const CLOSE_CODE_INVALID_RECONNECT: u16 = 4007;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSubSession {
    pub id: String,
    pub status: String,
    pub connected_at: DateTime<Utc>,
    pub keepalive_timeout_seconds: Option<u64>,
    pub reconnect_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSubMetadata {
    pub message_id: String,
    pub message_type: String,
    pub message_timestamp: DateTime<Utc>,
    pub subscription_type: Option<String>,
    pub subscription_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSubMessage {
    pub metadata: EventSubMetadata,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSubWelcomePayload {
    pub session: EventSubSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSubReconnectPayload {
    pub session: EventSubSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSubNotificationPayload {
    pub subscription: EventSubSubscription,
    pub event: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSubRevocationPayload {
    pub subscription: EventSubSubscription,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelPointsRedemption {
    pub id: String,
    pub broadcaster_user_id: String,
    pub broadcaster_user_login: String,
    pub broadcaster_user_name: String,
    pub user_id: String,
    pub user_login: String,
    pub user_name: String,
    pub user_input: Option<String>,
    pub status: String,
    pub reward: RewardInfo,
    pub redeemed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewardInfo {
    pub id: String,
    pub title: String,
    pub cost: u32,
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSubSubscription {
    pub id: String,
    pub status: String,
    pub r#type: String,
    pub version: String,
    pub condition: serde_json::Value,
    pub transport: EventSubTransport,
    pub created_at: DateTime<Utc>,
    pub cost: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSubTransport {
    pub method: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub enum EventSubConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Failed,
}

#[derive(Debug, Clone)]
pub enum EventSubEvent {
    SessionWelcome(EventSubSession),
    SessionReconnect(EventSubSession),
    Notification {
        subscription_type: String,
        subscription_version: String,
        subscription: EventSubSubscription,
        event: serde_json::Value,
    },
    Revocation {
        subscription_type: String,
        subscription: EventSubSubscription,
    },
    Keepalive,
    ConnectionStateChanged(EventSubConnectionState),
    Error(String),
}

pub struct TwitchEventSub {
    client_id: String,
    access_token: String,
    session: Arc<RwLock<Option<EventSubSession>>>,
    subscriptions: Arc<RwLock<Vec<EventSubSubscription>>>,
    connection_state: Arc<RwLock<EventSubConnectionState>>,
    event_sender: Arc<Mutex<Option<mpsc::UnboundedSender<EventSubEvent>>>>,
    reconnect_attempts: Arc<Mutex<usize>>,
}

impl Clone for TwitchEventSub {
    fn clone(&self) -> Self {
        Self {
            client_id: self.client_id.clone(),
            access_token: self.access_token.clone(),
            session: self.session.clone(),
            subscriptions: self.subscriptions.clone(),
            connection_state: self.connection_state.clone(),
            event_sender: self.event_sender.clone(),
            reconnect_attempts: self.reconnect_attempts.clone(),
        }
    }
}

impl TwitchEventSub {
    pub fn new(client_id: String, access_token: String) -> Self {
        Self {
            client_id,
            access_token,
            session: Arc::new(RwLock::new(None)),
            subscriptions: Arc::new(RwLock::new(Vec::new())),
            connection_state: Arc::new(RwLock::new(EventSubConnectionState::Disconnected)),
            event_sender: Arc::new(Mutex::new(None)),
            reconnect_attempts: Arc::new(Mutex::new(0)),
        }
    }

    pub async fn get_event_receiver(&self) -> mpsc::UnboundedReceiver<EventSubEvent> {
        let (sender, receiver) = mpsc::unbounded_channel();
        *self.event_sender.lock().await = Some(sender);
        receiver
    }

    async fn emit_event(&self, event: EventSubEvent) {
        if let Some(sender) = self.event_sender.lock().await.as_ref() {
            if let Err(_) = sender.send(event) {
                warn!("Failed to send event: receiver may have been dropped");
            }
        }
    }

    async fn set_connection_state(&self, state: EventSubConnectionState) {
        *self.connection_state.write().await = state.clone();
        self.emit_event(EventSubEvent::ConnectionStateChanged(state))
            .await;
    }

    #[instrument(skip(self))]
    pub async fn connect(&self) -> Result<()> {
        self.set_connection_state(EventSubConnectionState::Connecting)
            .await;

        let mut reconnect_url = None;
        loop {
            let attempts = *self.reconnect_attempts.lock().await;
            if attempts >= MAX_RECONNECT_ATTEMPTS {
                self.set_connection_state(EventSubConnectionState::Failed)
                    .await;
                return Err(anyhow!(
                    "Maximum reconnect attempts ({}) exceeded",
                    MAX_RECONNECT_ATTEMPTS
                ));
            }

            let connection_result = self.connect_internal(reconnect_url.clone()).await;

            match connection_result {
                Ok(new_reconnect_url) => {
                    // Reset reconnect attempts on successful connection
                    *self.reconnect_attempts.lock().await = 0;

                    if let Some(url) = new_reconnect_url {
                        reconnect_url = Some(url);
                        continue;
                    } else {
                        // Connection closed normally
                        break;
                    }
                }
                Err(e) => {
                    *self.reconnect_attempts.lock().await += 1;
                    error!("Connection failed (attempt {}): {}", attempts + 1, e);

                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            }
        }

        self.set_connection_state(EventSubConnectionState::Disconnected)
            .await;
        Ok(())
    }

    #[instrument(skip(self))]
    async fn connect_internal(&self, reconnect_url: Option<String>) -> Result<Option<String>> {
        let url = reconnect_url.unwrap_or_else(|| EVENTSUB_WEBSOCKET_URL.to_string());
        info!("Connecting to EventSub WebSocket: {}", url);

        let url = Url::parse(&url)?;
        let (ws_stream, _) = connect_async(url)
            .await
            .map_err(|e| anyhow!("Failed to connect to WebSocket: {}", e))?;

        let (mut write, mut read) = ws_stream.split();
        self.set_connection_state(EventSubConnectionState::Connected)
            .await;

        // keepalive monitoring
        let mut keepalive_interval = tokio::time::interval(DEFAULT_KEEPALIVE_TIMEOUT);
        let mut last_message_time = tokio::time::Instant::now();
        let mut current_keepalive_timeout = DEFAULT_KEEPALIVE_TIMEOUT;

        loop {
            tokio::select! {
                message = read.next() => {
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            last_message_time = tokio::time::Instant::now();
                            match self.handle_websocket_message(&text).await {
                                Ok(Some(reconnect_url)) => {
                                    info!("Received reconnect message, switching to new URL");
                                    return Ok(Some(reconnect_url));
                                }
                                Ok(None) => {
                                    if let Some(session) = self.session.read().await.as_ref() {
                                        if let Some(timeout_seconds) = session.keepalive_timeout_seconds {
                                            current_keepalive_timeout = Duration::from_secs(timeout_seconds);
                                            keepalive_interval = tokio::time::interval(current_keepalive_timeout);
                                        }
                                    }
                                }
                                Err(e) => {
                                    error!("Error handling WebSocket message: {}", e);
                                    self.emit_event(EventSubEvent::Error(e.to_string())).await;
                                }
                            }
                        }
                        Some(Ok(Message::Ping(data))) => {
                            debug!("Received ping, sending pong");
                            if let Err(e) = write.send(Message::Pong(data)).await {
                                error!("Failed to send pong: {}", e);
                                return Err(anyhow!("Failed to respond to ping: {}", e));
                            }
                        }
                        Some(Ok(Message::Close(close_frame))) => {
                            let code = close_frame.as_ref().map(|f| f.code.into()).unwrap_or(1000);
                            let reason = close_frame.as_ref()
                                .map(|f| f.reason.to_string())
                                .unwrap_or_else(|| "Unknown".to_string());

                            warn!("WebSocket closed with code {}: {}", code, reason);
                            self.handle_close_code(code).await;
                            return Ok(None);
                        }
                        Some(Err(e)) => {
                            error!("WebSocket error: {}", e);
                            return Err(anyhow!("WebSocket error: {}", e));
                        }
                        None => {
                            warn!("WebSocket stream ended");
                            return Ok(None);
                        }
                        _ => {}
                    }
                }

                // Monitor keepalive timeout
                _ = keepalive_interval.tick() => {
                    let elapsed = last_message_time.elapsed();
                    if elapsed > current_keepalive_timeout + Duration::from_secs(5) {
                        warn!("Keepalive timeout exceeded ({}s), reconnecting", elapsed.as_secs());
                        return Err(anyhow!("Keepalive timeout exceeded"));
                    }
                }
            }
        }
    }

    pub async fn subscribe_to_channel_points(&self, user_id: &str) -> Result<()> {
        if let Some(session) = self.session.read().await.as_ref() {
            Self::subscribe_to_channel_points_internal(
                &self.client_id,
                &self.access_token,
                &session.id,
                user_id,
            )
            .await
        } else {
            Err(anyhow!("No WebSocket session available"))
        }
    }

    #[instrument(skip(self, text))]
    async fn handle_websocket_message(&self, text: &str) -> Result<Option<String>> {
        debug!("Received WebSocket message: {}", text);

        let message: EventSubMessage = serde_json::from_str(text)
            .map_err(|e| anyhow!("Failed to parse EventSub message: {}", e))?;

        info!(
            "Received EventSub message type: {}",
            message.metadata.message_type
        );

        match message.metadata.message_type.as_str() {
            "session_welcome" => {
                let payload: EventSubWelcomePayload = serde_json::from_value(message.payload)
                    .map_err(|e| anyhow!("Failed to parse welcome payload: {}", e))?;

                info!("WebSocket session established: {}", payload.session.id);
                *self.session.write().await = Some(payload.session.clone());

                self.emit_event(EventSubEvent::SessionWelcome(payload.session))
                    .await;
                Ok(None)
            }

            "session_keepalive" => {
                debug!("Received keepalive message");
                self.emit_event(EventSubEvent::Keepalive).await;
                Ok(None)
            }

            "session_reconnect" => {
                let payload: EventSubReconnectPayload = serde_json::from_value(message.payload)
                    .map_err(|e| anyhow!("Failed to parse reconnect payload: {}", e))?;

                info!(
                    "Reconnect requested to: {:?}",
                    payload.session.reconnect_url
                );
                self.set_connection_state(EventSubConnectionState::Reconnecting)
                    .await;

                self.emit_event(EventSubEvent::SessionReconnect(payload.session.clone()))
                    .await;

                Ok(payload.session.reconnect_url)
            }

            "notification" => {
                let payload: EventSubNotificationPayload = serde_json::from_value(message.payload)
                    .map_err(|e| anyhow!("Failed to parse notification payload: {}", e))?;

                let subscription_type = message
                    .metadata
                    .subscription_type
                    .ok_or_else(|| anyhow!("Missing subscription_type in notification"))?;
                let subscription_version = message
                    .metadata
                    .subscription_version
                    .ok_or_else(|| anyhow!("Missing subscription_version in notification"))?;

                info!(
                    "Received event notification: {} v{}",
                    subscription_type, subscription_version
                );

                self.emit_event(EventSubEvent::Notification {
                    subscription_type,
                    subscription_version,
                    subscription: payload.subscription,
                    event: payload.event,
                })
                .await;

                Ok(None)
            }

            "revocation" => {
                let payload: EventSubRevocationPayload = serde_json::from_value(message.payload)
                    .map_err(|e| anyhow!("Failed to parse revocation payload: {}", e))?;

                let subscription_type = message
                    .metadata
                    .subscription_type
                    .ok_or_else(|| anyhow!("Missing subscription_type in revocation"))?;

                warn!(
                    "Subscription revoked: {} (status: {})",
                    subscription_type, payload.subscription.status
                );

                self.emit_event(EventSubEvent::Revocation {
                    subscription_type,
                    subscription: payload.subscription,
                })
                .await;

                Ok(None)
            }

            _ => {
                warn!("Unknown message type: {}", message.metadata.message_type);
                Ok(None)
            }
        }
    }

    async fn handle_close_code(&self, code: u16) {
        let error_message = match code {
            CLOSE_CODE_INTERNAL_SERVER_ERROR => "Internal server error".to_string(),
            CLOSE_CODE_CLIENT_SENT_INBOUND_TRAFFIC => {
                "Client sent inbound traffic (only pong messages allowed)".to_string()
            }
            CLOSE_CODE_CLIENT_FAILED_PING_PONG => {
                "Client failed to respond to ping messages".to_string()
            }
            CLOSE_CODE_CONNECTION_UNUSED => {
                "Connection unused - no subscription created within timeout".to_string()
            }
            CLOSE_CODE_RECONNECT_GRACE_TIME_EXPIRED => "Reconnect grace time expired".to_string(),
            CLOSE_CODE_NETWORK_TIMEOUT => "Network timeout".to_string(),
            CLOSE_CODE_NETWORK_ERROR => "Network error".to_string(),
            CLOSE_CODE_INVALID_RECONNECT => "Invalid reconnect URL".to_string(),
            _ => format!("Unknown close code: {}", code),
        };

        error!("WebSocket closed: {}", error_message);
        self.emit_event(EventSubEvent::Error(error_message)).await;
    }

    async fn subscribe_to_channel_points_internal(
        client_id: &str,
        access_token: &str,
        session_id: &str,
        user_id: &str,
    ) -> Result<()> {
        info!(
            "Subscribing to channel points redemptions for user: {}",
            user_id
        );

        let subscription_data = serde_json::json!({
            "type": "channel.channel_points_custom_reward_redemption.add",
            "version": "1",
            "condition": {
                "broadcaster_user_id": user_id
            },
            "transport": {
                "method": "websocket",
                "session_id": session_id
            }
        });

        let client = reqwest::Client::new();
        let response = client
            .post("https://api.twitch.tv/helix/eventsub/subscriptions")
            .header("Client-Id", client_id)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("Content-Type", "application/json")
            .json(&subscription_data)
            .send()
            .await?;

        if response.status().is_success() {
            info!("Successfully subscribed to channel points redemptions!");
            Ok(())
        } else {
            let status = response.status();
            let error_text = response.text().await?;
            Err(anyhow!(
                "Failed to subscribe: HTTP {} - {}",
                status,
                error_text
            ))
        }
    }

    pub async fn get_subscriptions(&self) -> Result<Vec<EventSubSubscription>> {
        let client = reqwest::Client::new();
        let response = client
            .get("https://api.twitch.tv/helix/eventsub/subscriptions")
            .header("Client-Id", &self.client_id)
            .header("Authorization", format!("Bearer {}", self.access_token))
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(anyhow!(
                "Failed to get subscriptions: HTTP {}",
                response.status()
            ));
        }

        #[derive(Deserialize)]
        struct SubscriptionsResponse {
            data: Vec<EventSubSubscription>,
        }

        let subscriptions_response: SubscriptionsResponse = response.json().await?;

        *self.subscriptions.write().await = subscriptions_response.data.clone();

        Ok(subscriptions_response.data)
    }

    pub async fn delete_subscription(&self, subscription_id: &str) -> Result<()> {
        let client = reqwest::Client::new();
        let response = client
            .delete(&format!(
                "https://api.twitch.tv/helix/eventsub/subscriptions?id={}",
                subscription_id
            ))
            .header("Client-Id", &self.client_id)
            .header("Authorization", format!("Bearer {}", self.access_token))
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(anyhow!(
                "Failed to delete subscription: HTTP {}",
                response.status()
            ));
        }

        info!("Subscription {} deleted successfully", subscription_id);
        Ok(())
    }

    pub async fn subscribe_to_events(
        &self,
        event_types: Vec<(&str, &str, serde_json::Value)>,
    ) -> Result<()> {
        let session = self.session.read().await;
        let session = session
            .as_ref()
            .ok_or_else(|| anyhow!("No WebSocket session available"))?;

        for (event_type, version, condition) in event_types {
            let subscription_data = serde_json::json!({
                "type": event_type,
                "version": version,
                "condition": condition,
                "transport": {
                    "method": "websocket",
                    "session_id": session.id
                }
            });

            let client = reqwest::Client::new();
            let response = client
                .post("https://api.twitch.tv/helix/eventsub/subscriptions")
                .header("Client-Id", &self.client_id)
                .header("Authorization", format!("Bearer {}", self.access_token))
                .header("Content-Type", "application/json")
                .json(&subscription_data)
                .send()
                .await?;

            if response.status().is_success() {
                info!("Successfully subscribed to {} v{}", event_type, version);
            } else {
                let status = response.status();
                let error_text = response.text().await?;
                error!(
                    "Failed to subscribe to {} v{}: HTTP {} - {}",
                    event_type, version, status, error_text
                );
                return Err(anyhow!(
                    "Failed to subscribe to {} v{}: HTTP {} - {}",
                    event_type,
                    version,
                    status,
                    error_text
                ));
            }
        }

        Ok(())
    }

    pub async fn get_connection_state(&self) -> EventSubConnectionState {
        self.connection_state.read().await.clone()
    }

    pub async fn get_session_info(&self) -> Option<EventSubSession> {
        self.session.read().await.clone()
    }
}

pub fn parse_channel_points_redemption(
    event: &serde_json::Value,
) -> Result<ChannelPointsRedemption> {
    let redemption: ChannelPointsRedemption = serde_json::from_value(event.clone())
        .map_err(|e| anyhow!("Failed to parse channel points redemption: {}", e))?;
    Ok(redemption)
}

pub fn create_common_subscriptions(
    broadcaster_user_id: &str,
) -> Vec<(&'static str, &'static str, serde_json::Value)> {
    vec![
        (
            "channel.channel_points_custom_reward_redemption.add",
            "1",
            serde_json::json!({"broadcaster_user_id": broadcaster_user_id}),
        ),
        (
            "channel.follow",
            "2",
            serde_json::json!({
                "broadcaster_user_id": broadcaster_user_id,
                "moderator_user_id": broadcaster_user_id
            }),
        ),
        (
            "channel.subscribe",
            "1",
            serde_json::json!({"broadcaster_user_id": broadcaster_user_id}),
        ),
        (
            "channel.subscription.gift",
            "1",
            serde_json::json!({"broadcaster_user_id": broadcaster_user_id}),
        ),
        (
            "channel.subscription.message",
            "1",
            serde_json::json!({"broadcaster_user_id": broadcaster_user_id}),
        ),
        (
            "channel.cheer",
            "1",
            serde_json::json!({"broadcaster_user_id": broadcaster_user_id}),
        ),
        (
            "channel.raid",
            "1",
            serde_json::json!({"to_broadcaster_user_id": broadcaster_user_id}),
        ),
        (
            "stream.online",
            "1",
            serde_json::json!({"broadcaster_user_id": broadcaster_user_id}),
        ),
        (
            "stream.offline",
            "1",
            serde_json::json!({"broadcaster_user_id": broadcaster_user_id}),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_eventsub_message_parsing() {
        let json = r#"
        {
            "metadata": {
                "message_id": "test-id",
                "message_type": "session_welcome",
                "message_timestamp": "2023-07-19T14:56:51.634234626Z"
            },
            "payload": {
                "session": {
                    "id": "test-session-id",
                    "status": "connected",
                    "connected_at": "2023-07-19T14:56:51.616329898Z",
                    "keepalive_timeout_seconds": 10,
                    "reconnect_url": null
                }
            }
        }"#;

        let message: EventSubMessage = serde_json::from_str(json).unwrap();
        assert_eq!(message.metadata.message_type, "session_welcome");

        let payload: EventSubWelcomePayload = serde_json::from_value(message.payload).unwrap();
        assert_eq!(payload.session.id, "test-session-id");
        assert_eq!(payload.session.status, "connected");
        assert_eq!(payload.session.keepalive_timeout_seconds, Some(10));
    }

    #[test]
    fn test_common_subscriptions() {
        let subscriptions = create_common_subscriptions("12345");
        assert!(!subscriptions.is_empty());

        let channel_points = subscriptions
            .iter()
            .find(|(event_type, _, _)| {
                *event_type == "channel.channel_points_custom_reward_redemption.add"
            })
            .unwrap();

        assert_eq!(channel_points.1, "1");
        assert_eq!(channel_points.2["broadcaster_user_id"], "12345");
    }

    #[tokio::test]
    async fn test_eventsub_client_creation() {
        let client = TwitchEventSub::new("test_client_id".to_string(), "test_token".to_string());

        let state = client.get_connection_state().await;
        matches!(state, EventSubConnectionState::Disconnected);

        let session = client.get_session_info().await;
        assert!(session.is_none());
    }
}
