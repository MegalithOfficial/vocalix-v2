use tauri::{command, AppHandle};
use tauri_plugin_store::StoreExt;
use serde::{Deserialize, Serialize};
use local_ip_address::local_ip;
use crate::log_info;

#[derive(Debug, Serialize, Deserialize)]
pub struct NetworkInfo {
    pub lan_ip: String,
    pub port: u16,
    pub is_running: bool,
}

#[command]
pub fn get_lan_ip() -> Result<String, String> {
    match local_ip() {
        Ok(ip) => {
            let ip_str = ip.to_string();
            log_info!("NetworkInfo", "Detected LAN IP: {}", ip_str);
            Ok(ip_str)
        },
        Err(e) => {
            log_info!("NetworkInfo", "Failed to get local IP: {}, using fallback", e);
            Ok("127.0.0.1".to_string())
        }
    }
}

#[command]
pub fn get_network_info(app: AppHandle) -> Result<NetworkInfo, String> {
    let lan_ip = get_lan_ip()?;
    
    let port = if let Ok(store) = app.store("settings.json") {
        match store.get("settings") {
            Some(settings) => match settings.get("server_port") {
                Some(port_val) => port_val.as_u64().unwrap_or(12345) as u16,
                None => 12345,
            },
            None => 12345,
        }
    } else {
        12345
    };
    
    Ok(NetworkInfo {
        lan_ip,
        port,
        is_running: false, 
    })
}
