use crate::{log_info, log_warn, log_error, log_debug, log_critical};
use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle};
use tauri_plugin_store::StoreExt;

#[derive(Debug, Serialize, Deserialize)]
pub struct SecuritySettings {
    pub p2p_port: u16,
    pub only_client_mode: bool,
}

#[command]
pub async fn save_security_settings(
    app: AppHandle,
    settings: SecuritySettings,
) -> Result<(), String> {
    log_debug!("SecuritySettings", "Saving security settings: {:?}", settings);
    
    let store = app.store("settings.json").map_err(|e| {
        log_error!("SecuritySettings", "Failed to get store: {}", e);
        e.to_string()
    })?;
    
    let settings_value = serde_json::to_value(&settings).map_err(|e| {
        log_error!("SecuritySettings", "Failed to serialize settings: {}", e);
        e.to_string()
    })?;
    store.set("settings", settings_value);
    
    store.save().map_err(|e| {
        log_critical!("SecuritySettings", "Failed to save security settings: {}", e);
        e.to_string()
    })?;
    
    log_info!("SecuritySettings", "Security settings saved successfully");
    Ok(())
}

#[command]
pub async fn load_security_settings(app: AppHandle) -> Result<SecuritySettings, String> {
    log_debug!("SecuritySettings", "Loading security settings");
    
    let store = app.store("settings.json").map_err(|e| {
        log_error!("SecuritySettings", "Failed to get store: {}", e);
        e.to_string()
    })?;
    
    if let Some(settings_value) = store.get("settings") {
        let settings: SecuritySettings = serde_json::from_value(settings_value.clone())
            .map_err(|e| {
                log_error!("SecuritySettings", "Failed to parse settings: {}", e);
                e.to_string()
            })?;
        log_info!("SecuritySettings", "Loaded security settings: {:?}", settings);
        Ok(settings)
    } else {
        log_warn!("SecuritySettings", "No saved settings found, using defaults");
        Ok(SecuritySettings {
            p2p_port: 12345,
            only_client_mode: false,
        })
    }
}

#[command]
pub async fn restart_app(app: AppHandle) -> Result<(), String> {
    app.restart();
}
