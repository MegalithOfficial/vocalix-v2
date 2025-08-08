#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod commands;
mod helpers;
mod logging;
mod services;
mod state;

use crate::services::pairing::AppState;
use crate::state::*;
use std::sync::Arc;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_store::StoreExt;
use tokio::sync::{broadcast, Mutex};

fn main() {
    let identity =
        crate::services::pairing::load_or_create_identity().expect("Failed to get identity.");
    let known_peers = crate::services::pairing::load_known_peers().expect("Failed to load peers.");

    let (tx, _rx) = broadcast::channel(1);

    let app_state = AppStateWithChannel {
        inner: AppState {
            device_identity: Arc::new(Mutex::new(Some(Arc::new(identity)))),
            known_peers: Arc::new(Mutex::new(known_peers)),
        },
        confirmation_tx: tx,
        message_tx: Arc::new(Mutex::new(None)),
        connection_state: Arc::new(Mutex::new(None)),
    };

    let twitch_state = TwitchState::default();

    let logging_state = LoggingState {
        log_file_path: Arc::new(std::sync::Mutex::new("logs/vocalix.log".to_string())),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(app_state)
        .manage(twitch_state)
        .manage(logging_state)
        .setup(|app| {
            if let Ok(app_data_dir) = app.path().app_data_dir() {
                let logs_dir = app_data_dir.join("logs");
                if let Err(e) = std::fs::create_dir_all(&logs_dir) {
                    eprintln!("Failed to create logs directory {:?}: {}", logs_dir, e);
                } else {
                    let log_file_path = logs_dir.join("vocalix.log");
                    if let Some(logging_state) = app.try_state::<LoggingState>() {
                        if let Ok(mut path) = logging_state.log_file_path.lock() {
                            *path = log_file_path.to_string_lossy().to_string();
                        }
                    }
                }
            } else {
                eprintln!("Failed to get app data directory, using relative logs path");
                if let Err(e) = std::fs::create_dir_all("logs") {
                    eprintln!("Failed to create logs directory: {}", e);
                }
            }
            #[allow(unused_variables)]
            {
                if let Ok(store) = app.store("settings.json") {
                    let only_client_mode = match store.get("settings") {
                        Some(settings) => match settings.get("only_client_mode") {
                            Some(v) => v.as_bool().unwrap_or(false),
                            None => false,
                        },
                        None => false,
                    };
                    let _ = app.emit("CLIENT_ONLY_MODE", only_client_mode);
                } else {
                    let _ = app.emit("CLIENT_ONLY_MODE", false);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::p2p::get_connection_status,
            commands::p2p::check_client_connection,
            commands::p2p::get_connection_state,
            commands::p2p::start_listener,
            commands::p2p::stop_listener,
            commands::p2p::start_initiator,
            commands::p2p::user_confirm_pairing,
            commands::p2p::send_chat_message,
            commands::p2p::send_redemption_without_timer,
            commands::p2p::send_redemption_with_timer,
            commands::twitch::twitch_authenticate,
            commands::twitch::twitch_start_event_listener,
            commands::twitch::twitch_stop_event_listener,
            commands::twitch::twitch_get_user_info,
            commands::twitch::twitch_sign_out,
            commands::twitch::twitch_is_authenticated,
            commands::twitch::twitch_save_credentials,
            commands::twitch::twitch_load_credentials,
            commands::twitch::twitch_has_saved_credentials,
            commands::twitch::twitch_delete_credentials,
            commands::twitch::twitch_get_auth_status,
            commands::twitch::get_twitch_redemptions,
            commands::audio::save_audio_file,
            commands::audio::get_audio_files,
            commands::audio::delete_audio_file,
            commands::tts::save_tts_settings,
            commands::tts::load_tts_settings,
            commands::tts::generate_tts,
            commands::python::save_pth_model,
            commands::python::get_pth_models,
            commands::python::delete_pth_model,
            commands::tts::test_tts_normal,
            commands::tts::test_tts_rvc,
            commands::python::setup_python_environment,
            commands::python::check_environment_status,
            commands::python::check_python_version,
            commands::python::check_library_versions,
            commands::python::get_available_devices,
            commands::python::force_reinstall_libraries,
            commands::python::reset_python_environment,
            commands::python::install_dependencies,
            commands::python::download_models,
            commands::python::validate_server_requirements,
            commands::network::get_lan_ip,
            commands::network::get_network_info,
            commands::security::save_security_settings,
            commands::security::load_security_settings,
            commands::security::restart_app,
            commands::log::write_log,
            commands::log::get_logs,
            commands::log::clear_logs,
            helpers::open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
