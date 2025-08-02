use crate::log_info;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn save_tts_settings(app: AppHandle, config: serde_json::Value) -> Result<(), String> {
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // Create app data directory if it doesn't exist
    fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;

    // Create the full path for texttospeech.json
    let config_path = app_data_dir.join("texttospeech.json");

    let config_str = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    fs::write(&config_path, config_str)
        .map_err(|e| format!("Failed to write TTS config: {}", e))?;

    log_info!("TTSSettings", "TTS settings saved to {:?}", config_path);
    Ok(())
}

#[tauri::command]
pub async fn load_tts_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let config_path = app_data_dir.join("texttospeech.json");

    match fs::read_to_string(&config_path) {
        Ok(content) => {
            let config: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse TTS config: {}", e))?;
            Ok(config)
        }
        Err(_) => {
            // Return empty config if file doesn't exist
            Ok(serde_json::json!({}))
        }
    }
}

#[tauri::command]
pub async fn test_tts_normal(provider: String, voice: String) -> Result<(), String> {
    // TODO: Implement normal TTS testing
    log_info!(
        "TTSTest",
        "Testing Normal TTS - Provider: {}, Voice: {}",
        provider,
        voice
    );
    Ok(())
}

#[tauri::command]
pub async fn test_tts_rvc(
    device: String,
    inference_rate: f64,
    filter_radius: i32,
    resample_rate: f64,
    protect_rate: f64,
) -> Result<(), String> {
    // TODO: Implement RVC TTS testing
    log_info!(
        "TTSTest",
        "Testing RVC TTS - Device: {}, IR: {}, FR: {}, RMR: {}, PR: {}",
        device,
        inference_rate,
        filter_radius,
        resample_rate,
        protect_rate
    );
    Ok(())
}
