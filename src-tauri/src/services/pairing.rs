use p256::{ecdh::EphemeralSecret, PublicKey};
use p256::ecdsa::{SigningKey, Signature, VerifyingKey};
use p256::ecdsa::signature::{Signer, Verifier};

use rand_core::{OsRng, RngCore};
use ring::{aead, digest, hkdf, hmac};
use serde::{Deserialize, Serialize};
use ::hkdf::Hkdf;
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone)]
pub struct AppState {
    pub device_identity: Arc<Mutex<Option<Arc<SigningKey>>>>,
    pub known_peers: Arc<Mutex<HashMap<String, Vec<u8>>>>, 
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            device_identity: Arc::new(Mutex::new(None)),
            known_peers: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

const KEYRING_SERVICE_NAME: &str = "com.megalith.vocalix_v2";
const DEVICE_IDENTITY_KEY: &str = "vocalix_device_identity";
const KNOWN_PEERS_KEY: &str = "known_peers";

#[derive(Serialize, Deserialize, Debug)]
pub struct KnownPeer {
    pub public_key_hex: String,
    pub long_term_secret_hex: String,
}

pub fn load_or_create_identity() -> anyhow::Result<SigningKey> {
    let entry = keyring::Entry::new(KEYRING_SERVICE_NAME, DEVICE_IDENTITY_KEY)?;
    match entry.get_password() {
        Ok(secret_hex) => Ok(SigningKey::from_slice(&hex::decode(secret_hex)?)?),
        Err(_) => {
            let sk = SigningKey::random(&mut OsRng);
            entry.set_password(&hex::encode(sk.to_bytes()))?;
            Ok(sk)
        }
    }
}

pub fn load_known_peers() -> anyhow::Result<HashMap<String, Vec<u8>>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE_NAME, KNOWN_PEERS_KEY)?;
    match entry.get_password() {
        Ok(json) => {
            let v: Vec<KnownPeer> = serde_json::from_str(&json)?;
            Ok(v.into_iter()
                .map(|kp| {
                    (
                        kp.public_key_hex,
                        hex::decode(kp.long_term_secret_hex).unwrap(),
                    )
                })
                .collect())
        }
        Err(_) => Ok(HashMap::new()),
    }
}

pub fn save_known_peers(peers: &HashMap<String, Vec<u8>>) -> anyhow::Result<()> {
    let v: Vec<KnownPeer> = peers
        .iter()
        .map(|(k, v)| KnownPeer {
            public_key_hex: k.clone(),
            long_term_secret_hex: hex::encode(v),
        })
        .collect();
    keyring::Entry::new(KEYRING_SERVICE_NAME, KNOWN_PEERS_KEY)?
        .set_password(&serde_json::to_string(&v)?)?;
    Ok(())
}


pub fn perform_initial_dh() -> (EphemeralSecret, Vec<u8>) {
    let sk = EphemeralSecret::random(&mut OsRng);
    let pk = sk.public_key().to_sec1_bytes().to_vec();
    set_last_my_eph_pub(pk.clone());
    (sk, pk)
}

pub fn perform_dh_exchange() -> (EphemeralSecret, PublicKey) {
    let sk = EphemeralSecret::random(&mut OsRng);
    let pk = sk.public_key();
    set_last_my_eph_pub(pk.to_sec1_bytes().to_vec());
    (sk, pk)
}

pub fn generate_pairing_code(peer_ephemeral_pub: &PublicKey) -> String {
    let their = peer_ephemeral_pub.to_sec1_bytes().to_vec();
    if let Some(my) = get_last_my_eph_pub() {
        let (a, b) = if my <= their {
            (my, their)
        } else {
            (their, my)
        };
        let ctx = sha256_concat(&[b"vocalix v2", &a, &b]);
        format_code_8(&ctx)
    } else {
        format_code_8(&their)
    }
}

fn format_code_8(bytes: &[u8]) -> String {
    let h = digest::digest(&digest::SHA256, bytes);
    let b = h.as_ref();
    let mut arr = [0u8; 8];
    arr.copy_from_slice(&b[0..8]);
    format!("{:08}", u64::from_be_bytes(arr) % 100_000_000)
}


pub fn create_challenge() -> (Vec<u8>, Vec<u8>) {
    let mut nonce = vec![0u8; 32];
    OsRng.fill_bytes(&mut nonce);
    set_last_challenge_nonce(nonce.clone());

    let id = load_or_create_identity().expect("identity");
    let pubkey = id.verifying_key().to_sec1_bytes().to_vec();
    (nonce, pubkey)
}

pub fn create_challenge_signature(
    state: &AppState,
    nonce: &Vec<u8>,
    listener_pub_key: &Vec<u8>,
) -> Vec<u8> {
    let sk = state
        .device_identity
        .blocking_lock()
        .as_ref()
        .expect("device identity not loaded")
        .clone();

    let mut msg = b"sdl challenge v1".to_vec();
    msg.extend_from_slice(listener_pub_key);
    msg.extend_from_slice(nonce);

    let sig: Signature = sk.sign(&msg);
    sig.to_der().as_bytes().to_vec()
}

pub fn verify_challenge_signature(
    peer_device_pubkey: &[u8],
    listener_pub_key: &[u8],
    signature: &[u8],
) -> bool {
    let Some(nonce) = get_last_challenge_nonce() else { return false; };

    let mut msg = b"sdl challenge v1".to_vec();
    msg.extend_from_slice(listener_pub_key);
    msg.extend_from_slice(&nonce);

    let Ok(vk) = VerifyingKey::from_sec1_bytes(peer_device_pubkey) else { return false; };
    if let Ok(sig) = Signature::from_der(signature) {
        return vk.verify(&msg, &sig).is_ok();
    }
    
    if signature.len() == 64 {
        if let Ok(sig) = Signature::from_bytes(signature.try_into().unwrap()) {
            return vk.verify(&msg, &sig).is_ok();
        }
    }
    false
}

fn device_mac_key() -> Vec<u8> {
    let id = load_or_create_identity().expect("identity");
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, b"vocalix v2 challenge");
    let prk = salt.extract(id.to_bytes().as_slice());
    let mut key = [0u8; 32];
    prk.expand(&[b"challenge mac"], hkdf::HKDF_SHA256)
        .unwrap()
        .fill(&mut key)
        .unwrap();
    key.to_vec()
}

pub fn create_session_keys(
    my_secret: &EphemeralSecret,
    peer_public_key_bytes: &[u8],
) -> anyhow::Result<(
    aead::LessSafeKey, // enc (me -> peer)
    aead::LessSafeKey, // dec (peer -> me)
    [u8; 4],           // nonce_prefix_send
    [u8; 4],           // nonce_prefix_recv
    [u8; 16],          // session_id
    [u8; 16],          // confirm_send_tag
    [u8; 16],          // confirm_recv_tag
)> {
    use anyhow::anyhow;

    let peer_public_key = PublicKey::from_sec1_bytes(peer_public_key_bytes)?;
    let shared_secret   = my_secret.diffie_hellman(&peer_public_key);

    let my_pub    = my_secret.public_key().to_sec1_bytes();
    let their_pub = peer_public_key.to_sec1_bytes();
    let (a, b)    = if my_pub <= their_pub { (my_pub.clone(), their_pub.clone()) } else { (their_pub.clone(), my_pub.clone()) };

    let transcript = {
        let mut ctx = digest::Context::new(&digest::SHA256);
        ctx.update(b"vocalix v2");
        ctx.update(&a);
        ctx.update(&b);
        ctx.finish().as_ref().to_vec()
    };

    let hk = Hkdf::<Sha256>::new(Some(&transcript), shared_secret.raw_secret_bytes());

    let mut k_ab = [0u8; 32];
    hk.expand(&label_dir("key", &a, &b, true),  &mut k_ab)
        .map_err(|_| anyhow!("HKDF expand k_ab failed"))?;
    let mut k_ba = [0u8; 32];
    hk.expand(&label_dir("key", &a, &b, false), &mut k_ba)
        .map_err(|_| anyhow!("HKDF expand k_ba failed"))?;

    let mut np_ab = [0u8; 4];
    hk.expand(&label_static(b"npfx A->B"), &mut np_ab)
        .map_err(|_| anyhow!("HKDF expand np_ab failed"))?;
    let mut np_ba = [0u8; 4];
    hk.expand(&label_static(b"npfx B->A"), &mut np_ba)
        .map_err(|_| anyhow!("HKDF expand np_ba failed"))?;

    let mut session_id = [0u8; 16];
    hk.expand(&label_static(b"session id"), &mut session_id)
        .map_err(|_| anyhow!("HKDF expand session_id failed"))?;

    let mut kc_ab = [0u8; 16];
    hk.expand(&label_static(b"confirm A->B"), &mut kc_ab)
        .map_err(|_| anyhow!("HKDF expand kc_ab failed"))?;
    let mut kc_ba = [0u8; 16];
    hk.expand(&label_static(b"confirm B->A"), &mut kc_ba)
        .map_err(|_| anyhow!("HKDF expand kc_ba failed"))?;

    let i_am_a = my_pub == a;
    let (k_send, k_recv, np_send, np_recv, kc_send, kc_recv) = if i_am_a {
        (k_ab, k_ba, np_ab, np_ba, kc_ab, kc_ba)
    } else {
        (k_ba, k_ab, np_ba, np_ab, kc_ba, kc_ab)
    };

    let enc_unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &k_send)
        .map_err(|_| anyhow!("Failed to create AEAD enc key"))?;
    let dec_unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &k_recv)
        .map_err(|_| anyhow!("Failed to create AEAD dec key"))?;

    let enc = aead::LessSafeKey::new(enc_unbound);
    let dec = aead::LessSafeKey::new(dec_unbound);

    Ok((enc, dec, np_send, np_recv, session_id, kc_send, kc_recv))
}


fn sha256_concat(parts: &[&[u8]]) -> Vec<u8> {
    let mut ctx = digest::Context::new(&digest::SHA256);
    for p in parts {
        ctx.update(p);
    }
    ctx.finish().as_ref().to_vec()
}

fn label_dir(kind: &str, a: &[u8], b: &[u8], a_to_b: bool) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"vocalix v2 ");
    v.extend_from_slice(kind.as_bytes());
    v.push(b' ');
    if a_to_b {
        v.extend_from_slice(a);
        v.extend_from_slice(b"->");
        v.extend_from_slice(b);
    } else {
        v.extend_from_slice(b);
        v.extend_from_slice(b"->");
        v.extend_from_slice(a);
    }
    v
}

fn label_static(label: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"vocalix v2 ");
    v.extend_from_slice(label);
    v
}

use once_cell::sync::Lazy;
use std::sync::Mutex as StdMutex;

static LAST_CHALLENGE_NONCE: Lazy<StdMutex<Option<Vec<u8>>>> = Lazy::new(|| StdMutex::new(None));
fn set_last_challenge_nonce(n: Vec<u8>) {
    *LAST_CHALLENGE_NONCE.lock().unwrap() = Some(n);
}
fn get_last_challenge_nonce() -> Option<Vec<u8>> {
    LAST_CHALLENGE_NONCE.lock().unwrap().clone()
}

static LAST_MY_EPH_PUB: Lazy<StdMutex<Option<Vec<u8>>>> = Lazy::new(|| StdMutex::new(None));
fn set_last_my_eph_pub(v: Vec<u8>) {
    *LAST_MY_EPH_PUB.lock().unwrap() = Some(v);
}
fn get_last_my_eph_pub() -> Option<Vec<u8>> {
    LAST_MY_EPH_PUB.lock().unwrap().clone()
}
