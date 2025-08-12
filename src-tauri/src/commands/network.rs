use tauri::{command, AppHandle};
use tauri_plugin_store::StoreExt;
use serde::{Deserialize, Serialize};
use local_ip_address::local_ip;
use crate::{log_info, log_warn, log_error, log_debug};

#[derive(Debug, Serialize, Deserialize)]
pub struct NetworkInfo {
    pub lan_ip: String,
    pub port: u16,
    pub is_running: bool,
}

#[command]
pub fn get_lan_ip() -> Result<String, String> {
    log_debug!("NetworkInfo", "Attempting to detect LAN IP address");
    
    match local_ip() {
        Ok(ip) => {
            let ip_str = ip.to_string();
            log_info!("NetworkInfo", "Detected LAN IP: {}", ip_str);
            Ok(ip_str)
        },
        Err(e) => {
            log_warn!("NetworkInfo", "Failed to get local IP: {}, using fallback", e);
            Ok("127.0.0.1".to_string())
        }
    }
}

#[command]
pub fn get_network_info(app: AppHandle) -> Result<NetworkInfo, String> {
    log_debug!("NetworkInfo", "Getting network information");
    
    let lan_ip = get_lan_ip()?;
    
    let port = if let Ok(store) = app.store("settings.json") {
        match store.get("settings") {
            Some(settings) => match settings.get("server_port") {
                Some(port_val) => {
                    let port = port_val.as_u64().unwrap_or(12345) as u16;
                    log_debug!("NetworkInfo", "Using configured port: {}", port);
                    port
                },
                None => {
                    log_debug!("NetworkInfo", "No port configured, using default: 12345");
                    12345
                },
            },
            None => {
                log_debug!("NetworkInfo", "No settings found, using default port: 12345");
                12345
            },
        }
    } else {
        log_error!("NetworkInfo", "Failed to access settings store, using default port");
        12345
    };
    
    let network_info = NetworkInfo {
        lan_ip,
        port,
        is_running: false, 
    };
    
    log_info!("NetworkInfo", "Network info: {:?}", network_info);
    Ok(network_info)
}
