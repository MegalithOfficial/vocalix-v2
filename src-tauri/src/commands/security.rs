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
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    
    let settings_value = serde_json::to_value(&settings).map_err(|e| e.to_string())?;
    store.set("settings", settings_value);
    
    store.save().map_err(|e| e.to_string())?;
    
    Ok(())
}

#[command]
pub async fn load_security_settings(app: AppHandle) -> Result<SecuritySettings, String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    
    if let Some(settings_value) = store.get("settings") {
        let settings: SecuritySettings = serde_json::from_value(settings_value.clone())
            .map_err(|e| e.to_string())?;
        Ok(settings)
    } else {
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
