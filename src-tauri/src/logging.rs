use serde::{Deserialize, Serialize};

// --- Logging Macros (defined early for use throughout) ---
// Logging macro for internal use
#[macro_export]
macro_rules! app_log {
    ($level:expr, $component:expr, $($arg:tt)*) => {
        {
            let message = format!($($arg)*);
            let timestamp = chrono::Utc::now().to_rfc3339();

            // Print to console
            match $level {
                "debug" => println!("[{}] [DEBUG] [{}] {}", timestamp, $component, message),
                "info" => println!("[{}] [INFO] [{}] {}", timestamp, $component, message),
                "warn" => eprintln!("[{}] [WARN] [{}] {}", timestamp, $component, message),
                "error" => eprintln!("[{}] [ERROR] [{}] {}", timestamp, $component, message),
                _ => println!("[{}] [{}] [{}] {}", timestamp, $level.to_uppercase(), $component, message),
            }

            // Write to file asynchronously (best effort)
            // Note: The log file path will be updated in setup() to use app data directory
            let log_file_path = "logs/vocalix.log".to_string();
            let log_line = format!(
                "[{}] [{}] [{}] {}\n",
                timestamp,
                $level.to_uppercase(),
                $component,
                message
            );

            std::thread::spawn(move || {
                use std::fs::{create_dir_all, OpenOptions};
                use std::io::Write;
                use std::path::Path;

                // Create logs directory if it doesn't exist
                if let Some(parent) = Path::new(&log_file_path).parent() {
                    let _ = create_dir_all(parent);
                }

                if let Ok(mut file) = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_file_path)
                {
                    let _ = file.write_all(log_line.as_bytes());
                    let _ = file.flush();
                }
            });
        }
    };
}

// Convenience macros
#[macro_export]
macro_rules! log_debug { ($component:expr, $($arg:tt)*) => { crate::app_log!("debug", $component, $($arg)*); }; }
#[macro_export]
macro_rules! log_info { ($component:expr, $($arg:tt)*) => { crate::app_log!("info", $component, $($arg)*); }; }
#[macro_export]
macro_rules! log_warn { ($component:expr, $($arg:tt)*) => { crate::app_log!("warn", $component, $($arg)*); }; }
#[macro_export]
macro_rules! log_error { ($component:expr, $($arg:tt)*) => { crate::app_log!("error", $component, $($arg)*); }; }

// --- Logging Types ---
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub component: String,
    pub message: String,
}
