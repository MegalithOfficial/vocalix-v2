use crate::logging::LogEntry;
use crate::state::LoggingState;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use tauri::State;

#[tauri::command]
pub async fn write_log(
    level: String,
    component: String,
    message: String,
    timestamp: String,
    logging_state: State<'_, LoggingState>,
) -> Result<(), String> {
    let log_entry = LogEntry {
        timestamp,
        level,
        component,
        message,
    };

    let log_file_path = logging_state
        .log_file_path
        .lock()
        .map_err(|e| format!("Failed to lock log file path: {}", e))?;

    // Create log line
    let log_line = format!(
        "[{}] [{}] [{}] {}\n",
        log_entry.timestamp,
        log_entry.level.to_uppercase(),
        log_entry.component,
        log_entry.message
    );

    // Write to file
    match fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&*log_file_path)
    {
        Ok(mut file) => {
            if let Err(e) = file.write_all(log_line.as_bytes()) {
                eprintln!("Failed to write log to file: {}", e);
                return Err(format!("Failed to write log: {}", e));
            }
            if let Err(e) = file.flush() {
                eprintln!("Failed to flush log file: {}", e);
            }
        }
        Err(e) => {
            eprintln!("Failed to open log file: {}", e);
            return Err(format!("Failed to open log file: {}", e));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn get_logs(logging_state: State<'_, LoggingState>) -> Result<Vec<LogEntry>, String> {
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

            // Return the last 1000 entries
            if logs.len() > 1000 {
                let start = logs.len() - 1000;
                logs.drain(0..start);
            }

            Ok(logs)
        }
        Err(_) => {
            // Return empty vec if file doesn't exist
            Ok(Vec::new())
        }
    }
}

#[tauri::command]
pub async fn clear_logs(logging_state: State<'_, LoggingState>) -> Result<(), String> {
    let log_file_path = logging_state
        .log_file_path
        .lock()
        .map_err(|e| format!("Failed to lock log file path: {}", e))?;

    match fs::write(&*log_file_path, "") {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Failed to clear log file: {}", e)),
    }
}

// Helper function to parse log lines
fn parse_log_line(line: &str) -> Option<LogEntry> {
    // Parse format: [timestamp] [LEVEL] [component] message
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

    Some(LogEntry {
        timestamp,
        level,
        component,
        message,
    })
}
