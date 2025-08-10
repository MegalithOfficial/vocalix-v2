use crate::services::p2p::handle_connection;
use crate::state::{AppStateWithChannel, Message, ConnectionState};
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
    let conn = state.connection_state.lock().await;
    Ok(matches!(*conn, Some(ConnectionState::Encrypted)))
}

#[tauri::command]
pub async fn get_connection_state(
    state: State<'_, AppStateWithChannel>,
) -> Result<String, String> {
    let conn = state.connection_state.lock().await;
    Ok(match &*conn {
        Some(ConnectionState::Authenticating) => "authenticating",
        Some(ConnectionState::WaitingForUserConfirmation) => "waiting_user",
        Some(ConnectionState::WaitingForPeerConfirmation) => "waiting_peer",
        Some(ConnectionState::Encrypted) => "encrypted",
        None => "disconnected",
    }.to_string())
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
        let disconnect_msg = Message::Disconnect { reason: "Server shutting down".to_string() };
        let serialized = serde_json::to_string(&disconnect_msg)
            .map_err(|e| format!("Failed to serialize disconnect message: {}", e))?;
        
        match tx.send(serialized) {
            Ok(_) => {
                window.emit("STATUS_UPDATE", "Disconnect message sent to client").ok();
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            },
            Err(e) => {
                println!("Failed to send disconnect message to client: {}", e);
                window.emit("STATUS_UPDATE", format!("Failed to notify client: {}", e)).ok();
            }
        }
    }
    drop(message_tx);
    {
        let mut conn = state.connection_state.lock().await;
        *conn = None;
    }
    {
        let mut tx = state.message_tx.lock().await;
        *tx = None;
    }
    
    window.emit("PEER_DISCONNECT", "Server stopped").ok();
    window.emit("STATUS_UPDATE", "Server stopped").unwrap();
    window.emit("SERVER_STOPPED", ()).unwrap();
        
    Ok(())
}

#[tauri::command]
pub async fn disconnect_client(
    window: Window,
    state: State<'_, AppStateWithChannel>,
) -> Result<(), String> {
    window.emit("STATUS_UPDATE", "Disconnecting client session...").ok();
    
    let maybe_tx = {
        let tx_guard = state.message_tx.lock().await;
        tx_guard.clone()
    };
    
    if let Some(tx) = maybe_tx {
        if let Ok(serialized) = serde_json::to_string(&Message::Disconnect { reason: "Client requested disconnect".into() }) {
            match tx.send(serialized) {
                Ok(_) => {
                    window.emit("STATUS_UPDATE", "Disconnect message sent to peer").ok();
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                },
                Err(e) => {
                    window.emit("STATUS_UPDATE", format!("Failed to send disconnect message: {}", e)).ok();
                }
            }
        }
    }
    
    {
        let mut tx = state.message_tx.lock().await;
        *tx = None;
    }
    {
        let mut cs = state.connection_state.lock().await;
        *cs = None;
    }
    
    window.emit("CLIENT_DISCONNECTED", "").ok();
    window.emit("PEER_DISCONNECT", "Local disconnect initiated").ok();
    window.emit("STATUS_UPDATE", "Client session disconnected").ok();
    Ok(())
}

#[tauri::command]
pub async fn send_disconnect_notice(
    reason: String,
    window: Window,
    state: State<'_, AppStateWithChannel>,
) -> Result<(), String> {
    let message_tx = state.message_tx.lock().await;
    if let Some(tx) = message_tx.as_ref() {
        let msg = Message::Disconnect { reason: reason.clone() };
        let serialized = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
        
        match tx.send(serialized) {
            Ok(_) => {
                window.emit("STATUS_UPDATE", format!("Disconnect notice sent: {}", reason)).ok();
                Ok(())
            },
            Err(e) => {
                window.emit("STATUS_UPDATE", format!("Failed to send disconnect notice: {}", e)).ok();
                Err(e.to_string())
            }
        }
    } else {
        window.emit("STATUS_UPDATE", "No active connection to send disconnect notice").ok();
        Err("No active connection".into())
    }
}

#[tauri::command]
pub async fn check_connection_health(
    window: Window,
    state: State<'_, AppStateWithChannel>,
) -> Result<bool, String> {
    let message_tx = state.message_tx.lock().await;
    let connection_state = state.connection_state.lock().await;
    
    match (message_tx.as_ref(), connection_state.as_ref()) {
        (Some(_), Some(_)) => {
            window.emit("STATUS_UPDATE", "Connection is healthy").ok();
            Ok(true)
        },
        _ => {
            window.emit("STATUS_UPDATE", "Connection is not healthy").ok();
            window.emit("PEER_DISCONNECT", "Connection health check failed").ok();
            Ok(false)
        }
    }
}
