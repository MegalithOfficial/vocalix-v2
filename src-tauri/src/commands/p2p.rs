use crate::p2p::handle_connection;
use crate::state::{AppStateWithChannel, Message};
use tauri::{State, Window, Emitter};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;

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
    audio: Vec<u8>,
    title: String,
    content: String,
    state: State<'_, AppStateWithChannel>,
) -> Result<(), String> {
    let message_tx = state.message_tx.lock().await;
    if let Some(tx) = message_tx.as_ref() {
        let redemption_msg = Message::RedemptionMessage {
            audio,
            title,
            content,
            message_type: 0, // redemption-without-timer
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
    audio: Vec<u8>,
    title: String,
    content: String,
    time: u32,
    state: State<'_, AppStateWithChannel>,
) -> Result<(), String> {
    let message_tx = state.message_tx.lock().await;
    if let Some(tx) = message_tx.as_ref() {
        let redemption_msg = Message::RedemptionMessage {
            audio,
            title,
            content,
            message_type: 1, // redemption-with-timer
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
