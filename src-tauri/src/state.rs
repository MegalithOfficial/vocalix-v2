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

#[derive(Debug, Clone, PartialEq)]
pub enum ConnectionState {
    Authenticating,
    WaitingForUserConfirmation,
    WaitingForPeerConfirmation,
    Encrypted,
}

pub struct SessionKeys {
    // Directional AEAD keys
    pub encryption_key: aead::LessSafeKey, // me -> peer
    pub decryption_key: aead::LessSafeKey, // peer -> me

    // Nonce sequencing
    pub send_nonce: Arc<Mutex<u64>>, // local send sequence (monotonic)
    pub recv_nonce: Arc<Mutex<Option<u64>>>,  // highest received sequence

    // Context binding
    pub session_id: [u8; 16], // bound into AAD
    pub nonce_prefix_send: [u8; 4], // 12B nonce = prefix(4) || seq(8)
    pub nonce_prefix_recv: [u8; 4],

    // Key confirmation tags
    pub confirm_send_tag: [u8; 16],
    pub confirm_recv_tag: [u8; 16],
}

pub struct AppStateWithChannel {
    pub inner: AppState,
    pub confirmation_tx: broadcast::Sender<bool>,
    pub message_tx: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
    pub connection_state: Arc<Mutex<Option<ConnectionState>>>,
}

#[derive(Default)]
pub struct TwitchState {
    pub auth_manager: Arc<Mutex<Option<Arc<TwitchAuthManager>>>>,
    pub event_sub: Arc<Mutex<Option<TwitchEventSub>>>,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Message {
    Hello(Vec<u8>),
    Challenge { nonce: Vec<u8>, listener_pub_key: Vec<u8> },
    ChallengeResponse(Vec<u8>),

    InitialDhKey(Vec<u8>),
    ResponseDhKey(Vec<u8>),

    PairingConfirmed, 

    SessionKeyRequest(Vec<u8>), // my ephemeral public key (SEC1)
    SessionKeyResponse(Vec<u8>), // peer ephemeral public key (SEC1)

    KeyConfirm(Vec<u8>),

    EncryptedMessage { ciphertext: Vec<u8>, nonce: [u8; 12] },

    RedemptionMessage {
        audio: Vec<u8>,
        title: String,
        content: String,
        message_type: u8,  // 0 = without timer, 1 = with timer
        time: Option<u32>, // seconds
    },

    PlaintextMessage(String),

    KeepAlive,
    KeepAliveAck,

    Disconnect { reason: String },
}
