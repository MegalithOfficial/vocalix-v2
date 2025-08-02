pub use crate::services::pairing::AppState;
use crate::services::twitch::TwitchEventSub;
use crate::services::twitch_oauth::TwitchAuthManager;
use ring::aead;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, Mutex};

pub struct LoggingState {
    pub log_file_path: Arc<std::sync::Mutex<String>>,
}

#[derive(Debug, Clone)]
pub enum ConnectionState {
    Authenticating,
    WaitingForUserConfirmation,
    WaitingForPeerConfirmation,
    Encrypted,
}

pub struct SessionKeys {
    pub encryption_key: aead::LessSafeKey,
    pub decryption_key: aead::LessSafeKey,
    pub send_nonce: Arc<Mutex<u64>>,
    pub recv_nonce: Arc<Mutex<u64>>,
}

pub struct AppStateWithChannel {
    pub inner: AppState,
    pub confirmation_tx: broadcast::Sender<bool>,
    pub message_tx: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
}

#[derive(Default)]
pub struct TwitchState {
    pub auth_manager: Arc<Mutex<Option<TwitchAuthManager>>>,
    pub event_sub: Arc<Mutex<Option<TwitchEventSub>>>,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Message {
    Hello(Vec<u8>),
    Challenge {
        nonce: Vec<u8>,
        listener_pub_key: Vec<u8>,
    },
    ChallengeResponse(Vec<u8>),

    // Key exchange for new peers
    InitialDhKey(Vec<u8>),
    ResponseDhKey(Vec<u8>),

    PairingConfirmed, // Sent after user confirms pairing

    SessionKeyRequest(Vec<u8>),  // Ephemeral public key for session
    SessionKeyResponse(Vec<u8>), // Ephemeral public key response
    EncryptionReady,

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

    PlaintextMessage(String), 
}
