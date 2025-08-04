use crate::services::p2p::handle_connection;
use crate::state::{AppStateWithChannel, Message};
use tauri::{Emitter, State, Window, Manager, AppHandle};
use tokio::net::{TcpListener, TcpStream};
use std::fs;

#[tauri::command]
pub async fn get_connection_status(
    state: State<'_, AppStateWithChannel>,
) -> Result<bool, String> {
    let message_tx = state.message_tx.lock().await;
    Ok(message_tx.is_some())
}

#[tauri::command]
pub async fn check_client_connection(
    state: State<'_, AppStateWithChannel>,
) -> Result<bool, String> {
    let message_tx = state.message_tx.lock().await;
    Ok(message_tx.is_some())
}

#[tauri::command]
pub async fn start_listener(
    window: Window,
    state: State<'_, AppStateWithChannel>,
) -> Result<(), String> {
    window
        .emit("STATUS_UPDATE", "Starting listener...")
        .unwrap();
    let listener = TcpListener::bind("0.0.0.0:12345")
        .await
        .map_err(|e| e.to_string())?;
    window
        .emit("STATUS_UPDATE", "Listening on 0.0.0.0:12345")
        .unwrap();

    let (stream, addr) = listener.accept().await.map_err(|e| e.to_string())?;
    window
        .emit(
            "STATUS_UPDATE",
            format!("Accepted connection from {}", addr),
        )
        .unwrap();

    let confirmation_rx = state.confirmation_tx.subscribe();
    tokio::spawn(handle_connection(
        stream,
        window,
        state.inner.clone(),
        confirmation_rx,
        state.message_tx.clone(),
        false,
    ));

    Ok(())
}

#[tauri::command]
pub async fn start_initiator(
    address: String,
    window: Window,
    state: State<'_, AppStateWithChannel>,
) -> Result<(), String> {
    window
        .emit("STATUS_UPDATE", format!("Connecting to {}...", address))
        .unwrap();
    let stream = TcpStream::connect(address)
        .await
        .map_err(|e| e.to_string())?;
    window
        .emit("STATUS_UPDATE", "Connection established!")
        .unwrap();

    let confirmation_rx = state.confirmation_tx.subscribe();
    tokio::spawn(handle_connection(
        stream,
        window,
        state.inner.clone(),
        confirmation_rx,
        state.message_tx.clone(),
        true,
    ));

    Ok(())
}

#[tauri::command]
pub async fn user_confirm_pairing(state: State<'_, AppStateWithChannel>) -> Result<(), String> {
    state
        .confirmation_tx
        .send(true)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn send_chat_message(
    message: String,
    state: State<'_, AppStateWithChannel>,
) -> Result<(), String> {
    let message_tx = state.message_tx.lock().await;
    if let Some(tx) = message_tx.as_ref() {
        tx.send(message)
            .map_err(|e| format!("Failed to send message: {}", e))?;
        Ok(())
    } else {
        Err("No active connection".to_string())
    }
}

#[tauri::command]
pub async fn send_redemption_without_timer(
    file_path: String,
    title: String,
    content: String,
    app: AppHandle,
    state: State<'_, AppStateWithChannel>,
) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let full_path = app_data_dir.join(&file_path);
    
    let audio_data = fs::read(&full_path)
        .map_err(|e| format!("Failed to read audio file {}: {}", full_path.display(), e))?;

    let message_tx = state.message_tx.lock().await;
    if let Some(tx) = message_tx.as_ref() {
        let redemption_msg = Message::RedemptionMessage {
            audio: audio_data,
            title,
            content,
            message_type: 0, 
            time: None,
        };
        let serialized = serde_json::to_string(&redemption_msg)
            .map_err(|e| format!("Failed to serialize redemption message: {}", e))?;
        tx.send(serialized)
            .map_err(|e| format!("Failed to send redemption message: {}", e))?;
        Ok(())
    } else {
        Err("No active connection".to_string())
    }
}

#[tauri::command]
pub async fn send_redemption_with_timer(
    file_path: String,
    title: String,
    content: String,
    time: u32,
    app: AppHandle,
    state: State<'_, AppStateWithChannel>,
) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let full_path = app_data_dir.join(&file_path);
    
    let audio_data = fs::read(&full_path)
        .map_err(|e| format!("Failed to read audio file {}: {}", full_path.display(), e))?;

    let message_tx = state.message_tx.lock().await;
    if let Some(tx) = message_tx.as_ref() {
        let redemption_msg = Message::RedemptionMessage {
            audio: audio_data,
            title,
            content,
            message_type: 1, 
            time: Some(time),
        };
        let serialized = serde_json::to_string(&redemption_msg)
            .map_err(|e| format!("Failed to serialize redemption message: {}", e))?;
        tx.send(serialized)
            .map_err(|e| format!("Failed to send redemption message: {}", e))?;
        Ok(())
    } else {
        Err("No active connection".to_string())
    }
}

#[tauri::command]
pub async fn stop_listener(
    window: Window,
    state: State<'_, AppStateWithChannel>,
) -> Result<(), String> {
    window
        .emit("STATUS_UPDATE", "Stopping server...")
        .unwrap();
    
    let message_tx = state.message_tx.lock().await;
    if let Some(tx) = message_tx.as_ref() {
        let shutdown_msg = Message::PlaintextMessage("Server shutting down".to_string());
        let serialized = serde_json::to_string(&shutdown_msg)
            .map_err(|e| format!("Failed to serialize shutdown message: {}", e))?;
        
        if let Err(e) = tx.send(serialized) {
            println!("Failed to send shutdown message to client: {}", e);
        }
    }
    
    window
        .emit("STATUS_UPDATE", "Server stopped")
        .unwrap();
    
    window
        .emit("SERVER_STOPPED", ())
        .unwrap();
        
    Ok(())
}
