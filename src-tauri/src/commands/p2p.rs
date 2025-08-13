use crate::{log_info, log_warn, log_error, log_debug, log_critical};
use crate::services::p2p::handle_connection;
use crate::state::{AppStateWithChannel, Message, ConnectionState};
use tauri::{Emitter, State, Window, Manager, AppHandle};
use tokio::net::{TcpListener, TcpStream, lookup_host}; 
use tokio::time::{timeout, Duration};
use std::fs;
use std::net::SocketAddr;

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
    log_info!("P2P", "Starting P2P listener on port 12345");
    window.emit("STATUS_UPDATE", "Starting listener...").ok();

    let listener = TcpListener::bind("0.0.0.0:12345").await.map_err(|e| {
        log_critical!("P2P", "Failed to bind listener to port 12345: {}", e);
        window.emit("ERROR", format!("Listener bind failed: {}", e)).ok();
        e.to_string()
    })?;

    log_info!("P2P", "Successfully bound listener to 0.0.0.0:12345");
    window.emit("STATUS_UPDATE", "Listening on 0.0.0.0:12345").ok();

    // Clone stable handles for the accept loop
    let win = window.clone();
    let app_state = state.inner.clone();
    let confirm_tx = state.confirmation_tx.clone();
    let msg_tx = state.message_tx.clone();

    // Accept loop (keeps listening for new clients)
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, addr)) => {
                    log_info!("P2P", "Accepted connection from {}", addr);
                    win.emit("STATUS_UPDATE", format!("Accepted connection from {}", addr)).ok();

                    // Her bağlantı için yeni subscriber
                    let confirmation_rx = confirm_tx.subscribe();

                    // Bağlantı handler'ını spawn et
                    tokio::spawn(handle_connection(
                        stream,
                        win.clone(),
                        app_state.clone(),
                        confirmation_rx,
                        msg_tx.clone(),
                        false, // LISTENER
                    ));

                    log_debug!("P2P", "Connection handler spawned for incoming connection");
                }
                Err(e) => {
                    log_error!("P2P", "Failed to accept connection: {}", e);
                    win.emit("ERROR", format!("Accept failed: {}", e)).ok();
                    // Kısa bekleyip tekrar dene (spin koruması)
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn start_initiator(
    address: String,
    window: Window,
    state: State<'_, AppStateWithChannel>,
) -> Result<(), String> {
    let addr: SocketAddr = address.parse().map_err(|e| {
        let msg = format!("Invalid address (use IP:PORT): {} ({})", address, e);
        window.emit("ERROR", &msg).ok();
        msg
    })?;

    let mut resolved = lookup_host(addr).await.map_err(|e| e.to_string())?;
    if let Some(first) = resolved.next() {
        window.emit("STATUS_UPDATE", format!("Connecting to {}", first)).ok();
    } else {
        window.emit("ERROR", "Could not resolve target").ok();
        return Err("resolve failed".into());
    }

    let stream = match timeout(Duration::from_secs(10), TcpStream::connect(addr)).await {
        Err(_) => {
            let msg = format!("Connect timeout to {}", addr);
            window.emit("ERROR", &msg).ok();
            return Err(msg);
        }
        Ok(Err(e)) => {
            let msg = format!("Connect failed to {}: {}", addr, e);
            window.emit("ERROR", &msg).ok();
            return Err(msg);
        }
        Ok(Ok(s)) => s,
    };

    window.emit("STATUS_UPDATE", "Connection established!").ok();

    let confirmation_rx = state.confirmation_tx.subscribe();
    tokio::spawn(handle_connection(
        stream,
        window,
        state.inner.clone(),
        confirmation_rx,
        state.message_tx.clone(),
        true, // initiator
    ));
    Ok(())
}

#[tauri::command]
pub async fn user_confirm_pairing(state: State<'_, AppStateWithChannel>) -> Result<(), String> {
    state.confirmation_tx.send(true).map_err(|e| e.to_string())?;
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
    window.emit("STATUS_UPDATE", "Stopping server...").ok();

    let message_tx = state.message_tx.lock().await;
    if let Some(tx) = message_tx.as_ref() {
        let disconnect_msg = Message::Disconnect { reason: "Server shutting down".to_string() };
        let serialized = serde_json::to_string(&disconnect_msg)
            .map_err(|e| format!("Failed to serialize disconnect message: {}", e))?;

        match tx.send(serialized) {
            Ok(_) => {
                window.emit("STATUS_UPDATE", "Disconnect message sent to client").ok();
                tokio::time::sleep(Duration::from_millis(100)).await;
            },
            Err(e) => {
                log_warn!("P2P", "Failed to send disconnect message to client: {}", e);
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
    window.emit("STATUS_UPDATE", "Server stopped").ok();
    window.emit("SERVER_STOPPED", ()).ok();

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
                    tokio::time::sleep(Duration::from_millis(100)).await;
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
