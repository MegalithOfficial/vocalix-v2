use crate::{log_debug, log_error, log_info, log_warn};
use local_ip_address::{list_afinet_netifas, local_ip};
use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle};
use tauri_plugin_store::StoreExt;
use std::net::IpAddr;

#[derive(Debug, Serialize, Deserialize)]
pub struct NetworkInfo {
    pub lan_ip: String,
    pub port: u16,
    pub is_running: bool,
}

#[command]
pub fn get_lan_ip() -> Result<String, String> {
    log_debug!("NetworkInfo", "Attempting to detect LAN IP address");

    if let Ok(ip) = local_ip() {
        if is_valid_lan_ip(&ip) {
            let ip_str = ip.to_string();
            log_info!("NetworkInfo", "Detected LAN IP: {}", ip_str);
            return Ok(ip_str);
        }
        log_warn!(
            "NetworkInfo",
            "local_ip returned non-LAN address: {}, scanning interfaces",
            ip
        );
    } else {
        log_warn!("NetworkInfo", "local_ip failed, scanning interfaces");
    }

    if let Ok(interfaces) = list_afinet_netifas() {
        if let Some(ip) = select_best_lan_ip(&interfaces) {
            let ip_str = ip.to_string();
            log_info!("NetworkInfo", "Selected LAN IP: {}", ip_str);
            return Ok(ip_str);
        }
    }

    Err("Could not determine a LAN IP address. Check your network connection and enter the IP manually.".to_string())
}

fn select_best_lan_ip(interfaces: &[(String, IpAddr)]) -> Option<IpAddr> {
    // Prefer private IPv4 addresses
    for (_name, ip) in interfaces {
        if is_valid_lan_ip(ip) {
            return Some(*ip);
        }
    }
    // Fallback: any non-loopback IPv4
    for (_name, ip) in interfaces {
        if ip.is_ipv4() && !ip.is_loopback() {
            return Some(*ip);
        }
    }
    None
}

fn is_valid_lan_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            if v4.is_loopback() || v4.is_link_local() || v4.is_multicast() || v4.is_unspecified() {
                return false;
            }
            let octets = v4.octets();
            matches!(octets[0], 10)
                || (octets[0] == 172 && (16..=31).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 168)
        }
        IpAddr::V6(_) => false,
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
                }
                None => {
                    log_debug!("NetworkInfo", "No port configured, using default: 12345");
                    12345
                }
            },
            None => {
                log_debug!(
                    "NetworkInfo",
                    "No settings found, using default port: 12345"
                );
                12345
            }
        }
    } else {
        log_error!(
            "NetworkInfo",
            "Failed to access settings store, using default port"
        );
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
