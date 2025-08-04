use crate::log_info;
use tauri::{AppHandle, Manager, Emitter};
use std::sync::{Arc, Mutex};
use std::process::{Command, Child};

// Global audio process state
static AUDIO_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

#[tauri::command]
pub async fn save_audio_file(
    app: AppHandle,
    redemption_name: String,
    file_name: String,
    base64_data: String,
) -> Result<(), String> {
    log_info!(
        "AudioManager",
        "Saving audio file: {} for redemption: {}",
        file_name,
        redemption_name
    );

    use base64::{engine::general_purpose, Engine as _};
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // Create the directory structure: static_audios/<redemption_name>/
    let dir_path = app_data_dir.join("static_audios").join(&redemption_name);
    fs::create_dir_all(&dir_path)
        .map_err(|e| format!("Failed to create directory {:?}: {}", dir_path, e))?;

    // Decode base64 data
    let audio_data = general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Failed to decode base64 data: {}", e))?;

    // Write the file
    let file_path = dir_path.join(&file_name);
    fs::write(&file_path, audio_data)
        .map_err(|e| format!("Failed to write file {:?}: {}", file_path, e))?;

    log_info!("AudioManager", "Saved audio file: {:?}", file_path);
    Ok(())
}

#[tauri::command]
pub async fn get_audio_files(
    app: AppHandle,
    redemption_name: String,
) -> Result<Vec<String>, String> {
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let dir_path = app_data_dir.join("static_audios").join(&redemption_name);

    // Check if directory exists
    if !dir_path.exists() {
        return Ok(Vec::new());
    }

    // Read directory contents
    let entries = fs::read_dir(&dir_path)
        .map_err(|e| format!("Failed to read directory {:?}: {}", dir_path, e))?;

    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_file() {
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                // Only include .mp3 files
                if file_name.ends_with(".mp3") {
                    files.push(file_name.to_string());
                }
            }
        }
    }

    // Sort files for consistent ordering
    files.sort();
    Ok(files)
}

#[tauri::command]
pub async fn delete_audio_file(
    app: AppHandle,
    redemption_name: String,
    file_name: String,
) -> Result<(), String> {
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let file_path = app_data_dir
        .join("static_audios")
        .join(&redemption_name)
        .join(&file_name);

    // Check if file exists
    if !file_path.exists() {
        return Err(format!("File does not exist: {:?}", file_path));
    }

    // Delete the file
    fs::remove_file(&file_path)
        .map_err(|e| format!("Failed to delete file {:?}: {}", file_path, e))?;

    log_info!("AudioManager", "Deleted audio file: {:?}", file_path);

    // Try to remove directory if it's empty
    let dir_path = app_data_dir.join("static_audios").join(&redemption_name);
    if let Ok(entries) = fs::read_dir(&dir_path) {
        if entries.count() == 0 {
            let _ = fs::remove_dir(&dir_path); // Ignore errors for directory removal
            log_info!("AudioManager", "Removed empty directory: {:?}", dir_path);
        }
    }

    Ok(())
}
