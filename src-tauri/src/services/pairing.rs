use p256::{ecdh::EphemeralSecret, ecdsa::SigningKey, PublicKey};
use rand_core::OsRng;
use ring::{aead, digest, hkdf, hmac};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

pub const KEYRING_SERVICE_NAME: &str = "com.megalith.vocalix_v2";
const DEVICE_IDENTITY_KEY: &str = "vocalix_device_identity";
const KNOWN_PEERS_KEY: &str = "known_peers";

#[derive(Serialize, Deserialize, Debug)]
pub struct KnownPeer {
    pub public_key_hex: String,
    pub long_term_secret_hex: String,
}

#[derive(Default, Clone)]
pub struct AppState {
    pub device_identity: Arc<Mutex<Option<Arc<SigningKey>>>>,
    pub known_peers: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

pub fn load_or_create_identity() -> anyhow::Result<SigningKey> {
    let entry = keyring::Entry::new(KEYRING_SERVICE_NAME, DEVICE_IDENTITY_KEY)?;
    match entry.get_password() {
        Ok(secret_hex) => {
            let secret_bytes = hex::decode(secret_hex)?;
            Ok(SigningKey::from_slice(&secret_bytes)?)
        }
        Err(_) => {
            println!("No existing identity found. Creating a new one.");
            let secret = SigningKey::random(&mut OsRng);
            let secret_bytes = secret.to_bytes();
            entry.set_password(&hex::encode(secret_bytes))?;
            println!("New identity created and saved to keychain.");
            Ok(secret)
        }
    }
}

pub fn load_known_peers() -> anyhow::Result<HashMap<String, Vec<u8>>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE_NAME, KNOWN_PEERS_KEY)?;
    match entry.get_password() {
        Ok(peers_json) => {
            let peers: Vec<KnownPeer> = serde_json::from_str(&peers_json)?;
            let mut peer_map = HashMap::new();
            for peer in peers {
                peer_map.insert(peer.public_key_hex, hex::decode(peer.long_term_secret_hex)?);
            }
            Ok(peer_map)
        }
        Err(_) => {
            println!("No known peers found. Starting fresh.");
            Ok(HashMap::new())
        }
    }
}

pub fn save_known_peers(peers: &HashMap<String, Vec<u8>>) -> anyhow::Result<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE_NAME, KNOWN_PEERS_KEY)?;
    let serializable_peers: Vec<KnownPeer> = peers
        .iter()
        .map(|(k, v)| KnownPeer {
            public_key_hex: k.clone(),
            long_term_secret_hex: hex::encode(v),
        })
        .collect();
    let json = serde_json::to_string(&serializable_peers)?;
    entry.set_password(&json)?;
    Ok(())
}

pub fn perform_dh_exchange() -> (EphemeralSecret, PublicKey) {
    let private_key = EphemeralSecret::random(&mut OsRng);
    let public_key = private_key.public_key();
    (private_key, public_key)
}

pub fn generate_6_digit_code(shared_secret: &[u8]) -> String {
    let hash = digest::digest(&digest::SHA256, shared_secret);
    let hash_bytes = hash.as_ref();
    let num = u32::from_be_bytes([hash_bytes[0], hash_bytes[1], hash_bytes[2], hash_bytes[3]]);
    format!("{:06}", num % 1_000_000)
}

pub fn create_challenge_signature(long_term_secret: &[u8], nonce: &[u8]) -> hmac::Tag {
    let key = hmac::Key::new(hmac::HMAC_SHA256, long_term_secret);
    hmac::sign(&key, nonce)
}

pub fn verify_challenge_signature(long_term_secret: &[u8], nonce: &[u8], signature: &[u8]) -> bool {
    let key = hmac::Key::new(hmac::HMAC_SHA256, long_term_secret);
    hmac::verify(&key, nonce, signature).is_ok()
}

pub fn create_session_keys(
    my_secret: &EphemeralSecret,
    peer_public_key_bytes: &[u8],
) -> anyhow::Result<(aead::LessSafeKey, aead::LessSafeKey)> {
    let peer_public_key = PublicKey::from_sec1_bytes(peer_public_key_bytes)?;

    let shared_secret = my_secret.diffie_hellman(&peer_public_key);

    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, &[]);
    let prk = salt.extract(shared_secret.raw_secret_bytes());

    let mut key_bytes = [0u8; 32];
    let okm = prk
        .expand(&[b"session_key_info"], hkdf::HKDF_SHA256)
        .map_err(|_| anyhow::anyhow!("HKDF expand failed"))?;
    okm.fill(&mut key_bytes)
        .map_err(|_| anyhow::anyhow!("HKDF fill failed"))?;

    let unbound_key1 = aead::UnboundKey::new(&aead::AES_256_GCM, &key_bytes)
        .map_err(|_| anyhow::anyhow!("Failed to create unbound key"))?;
    let unbound_key2 = aead::UnboundKey::new(&aead::AES_256_GCM, &key_bytes)
        .map_err(|_| anyhow::anyhow!("Failed to create unbound key"))?;

    let opening_key = aead::LessSafeKey::new(unbound_key1);
    let sealing_key = aead::LessSafeKey::new(unbound_key2);

    Ok((opening_key, sealing_key))
}

#[derive(Clone, Copy)]
struct MyNonceSequence(u64);

impl aead::NonceSequence for MyNonceSequence {
    fn advance(&mut self) -> Result<aead::Nonce, ring::error::Unspecified> {
        let mut nonce_bytes = [0u8; 12];
        let val = self.0;
        nonce_bytes[..8].copy_from_slice(&val.to_be_bytes());
        self.0 += 1;
        Ok(aead::Nonce::assume_unique_for_key(nonce_bytes))
    }
}
