use crate::logging::{LogEntry, get_logs as get_logs_from_buffer, clear_logs as clear_logs_buffer};
use crate::state::LoggingState;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use tauri::State;

#[tauri::command]
pub async fn write_log(
    level: String,
    component: String,
    message: String,
    _timestamp: String,
    logging_state: State<'_, LoggingState>,
) -> Result<(), String> {
    log_info!("LogCommand", "Frontend requested log write: [{}] [{}] {}", level, component, message);
    
    let log_entry = LogEntry {
        timestamp: chrono::Utc::now(),
        level: match level.to_lowercase().as_str() {
            "debug" => crate::logging::LogLevel::Debug,
            "info" => crate::logging::LogLevel::Info,
            "warn" => crate::logging::LogLevel::Warn,
            "error" => crate::logging::LogLevel::Error,
            "critical" => crate::logging::LogLevel::Critical,
            _ => crate::logging::LogLevel::Info,
        },
        component,
        message,
        context: None,
    };

    let log_file_path = logging_state
        .log_file_path
        .lock()
        .map_err(|e| format!("Failed to lock log file path: {}", e))?;

    let log_line = format!(
        "[{}] [{}] [{}] {}\n",
        log_entry.timestamp.format("%Y-%m-%d %H:%M:%S%.3f UTC"),
        log_entry.level,
        log_entry.component,
        log_entry.message
    );

    match fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&*log_file_path)
    {
        Ok(mut file) => {
            if let Err(e) = file.write_all(log_line.as_bytes()) {
                log_error!("LogCommand", "Failed to write log to file: {}", e);
                return Err(format!("Failed to write log: {}", e));
            }
            if let Err(e) = file.flush() {
                log_warn!("LogCommand", "Failed to flush log file: {}", e);
            }
        }
        Err(e) => {
            log_error!("LogCommand", "Failed to open log file: {}", e);
            return Err(format!("Failed to open log file: {}", e));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn get_logs(logging_state: State<'_, LoggingState>) -> Result<Vec<serde_json::Value>, String> {
    log_debug!("LogCommand", "Getting logs from buffer and file");
    
    let buffer_logs = get_logs_from_buffer();
    if !buffer_logs.is_empty() {
        log_info!("LogCommand", "Returning {} logs from memory buffer", buffer_logs.len());
        let serialized_logs: Vec<serde_json::Value> = buffer_logs
            .into_iter()
            .map(|entry| serde_json::json!({
                "timestamp": entry.timestamp.format("%Y-%m-%d %H:%M:%S%.3f UTC").to_string(),
                "level": entry.level.to_string().to_lowercase(),
                "component": entry.component,
                "message": entry.message,
                "context": entry.context
            }))
            .collect();
        return Ok(serialized_logs);
    }

    let log_file_path = logging_state
        .log_file_path
        .lock()
        .map_err(|e| format!("Failed to lock log file path: {}", e))?;

    match fs::File::open(&*log_file_path) {
        Ok(file) => {
            let reader = BufReader::new(file);
            let mut logs = Vec::new();

            for line in reader.lines() {
                if let Ok(line) = line {
                    if let Some(log_entry) = parse_log_line(&line) {
                        logs.push(log_entry);
                    }
                }
            }

            if logs.len() > 1000 {
                let start = logs.len() - 1000;
                logs.drain(0..start);
            }

            log_info!("LogCommand", "Returning {} logs from file", logs.len());
            Ok(logs)
        }
        Err(e) => {
            log_warn!("LogCommand", "Could not read log file: {}", e);
            Ok(Vec::new())
        }
    }
}

#[tauri::command]
pub async fn clear_logs(logging_state: State<'_, LoggingState>) -> Result<(), String> {
    log_info!("LogCommand", "Clearing logs (both buffer and file)");
    
    clear_logs_buffer();
    
    let log_file_path = logging_state
        .log_file_path
        .lock()
        .map_err(|e| format!("Failed to lock log file path: {}", e))?;

    match fs::write(&*log_file_path, "") {
        Ok(_) => {
            log_info!("LogCommand", "Successfully cleared log file");
            Ok(())
        },
        Err(e) => {
            log_error!("LogCommand", "Failed to clear log file: {}", e);
            Err(format!("Failed to clear log file: {}", e))
        }
    }
}

fn parse_log_line(line: &str) -> Option<serde_json::Value> {
    if line.len() < 10 || !line.starts_with('[') {
        return None;
    }

    let parts: Vec<&str> = line.splitn(4, ']').collect();
    if parts.len() != 4 {
        return None;
    }

    let timestamp = parts[0].trim_start_matches('[').to_string();
    let level = parts[1].trim_start_matches(" [").to_lowercase();
    let component = parts[2].trim_start_matches(" [").to_string();
    let message = parts[3].trim_start_matches(' ').to_string();

    Some(serde_json::json!({
        "timestamp": timestamp,
        "level": level,
        "component": component,
        "message": message
    }))
}
