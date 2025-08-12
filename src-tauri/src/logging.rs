use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

static LOGGER: OnceLock<Arc<Mutex<Logger>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: DateTime<Utc>,
    pub level: LogLevel,
    pub component: String,
    pub message: String,
    pub context: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
    Critical,
}

impl LogLevel {
    fn to_color_code(&self) -> &'static str {
        match self {
            LogLevel::Debug => "\x1b[36m",    // Cyan
            LogLevel::Info => "\x1b[32m",     // Green
            LogLevel::Warn => "\x1b[33m",     // Yellow
            LogLevel::Error => "\x1b[31m",    // Red
            LogLevel::Critical => "\x1b[35m", // Magenta
        }
    }
}

impl std::fmt::Display for LogLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LogLevel::Debug => write!(f, "DEBUG"),
            LogLevel::Info => write!(f, "INFO"),
            LogLevel::Warn => write!(f, "WARN"),
            LogLevel::Error => write!(f, "ERROR"),
            LogLevel::Critical => write!(f, "CRITICAL"),
        }
    }
}

#[derive(Debug)]
pub struct Logger {
    log_file_path: String,
    app_handle: Option<AppHandle>,
    buffer: Vec<LogEntry>,
    max_buffer_size: usize,
}

impl Logger {
    pub fn new(log_file_path: String) -> Self {
        Self {
            log_file_path,
            app_handle: None,
            buffer: Vec::new(),
            max_buffer_size: 1000,
        }
    }

    pub fn set_app_handle(&mut self, app_handle: AppHandle) {
        self.app_handle = Some(app_handle);
    }

    pub fn set_log_file_path(&mut self, path: String) {
        self.log_file_path = path;
    }

    pub fn log(&mut self, level: LogLevel, component: &str, message: &str, context: Option<HashMap<String, serde_json::Value>>) {
        let entry = LogEntry {
            timestamp: Utc::now(),
            level: level.clone(),
            component: component.to_string(),
            message: message.to_string(),
            context,
        };

        let color = level.to_color_code();
        let reset = "\x1b[0m";
        let timestamp_str = entry.timestamp.format("%Y-%m-%d %H:%M:%S%.3f UTC");
        
        match level {
            LogLevel::Error | LogLevel::Critical => {
                eprintln!(
                    "{}[{}] [{}] [{}] {}{}",
                    color, timestamp_str, level, component, message, reset
                );
            }
            _ => {
                println!(
                    "{}[{}] [{}] [{}] {}{}",
                    color, timestamp_str, level, component, message, reset
                );
            }
        }

        self.buffer.push(entry.clone());
        if self.buffer.len() > self.max_buffer_size {
            self.buffer.remove(0);
        }

        self.write_to_file(&entry);

        if let Some(app_handle) = &self.app_handle {
            let _ = app_handle.emit("LOG_ENTRY", &entry);
        }
    }

    fn write_to_file(&self, entry: &LogEntry) {
        let log_line = format!(
            "[{}] [{}] [{}] {}\n",
            entry.timestamp.format("%Y-%m-%d %H:%M:%S%.3f UTC"),
            entry.level,
            entry.component,
            entry.message
        );

        let log_file_path = self.log_file_path.clone();
        tokio::spawn(async move {
            use std::fs::{create_dir_all, OpenOptions};
            use std::io::Write;
            use std::path::Path;

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

    pub fn get_logs(&self) -> Vec<LogEntry> {
        self.buffer.clone()
    }

    pub fn clear_logs(&mut self) {
        self.buffer.clear();
    }
}

pub fn init_logger(log_file_path: String) {
    let logger = Arc::new(Mutex::new(Logger::new(log_file_path)));
    LOGGER.set(logger).expect("Logger already initialized");
}

pub fn set_app_handle(app_handle: AppHandle) {
    if let Some(logger) = LOGGER.get() {
        if let Ok(mut logger) = logger.lock() {
            logger.set_app_handle(app_handle);
        }
    }
}

pub fn set_log_file_path(path: String) {
    if let Some(logger) = LOGGER.get() {
        if let Ok(mut logger) = logger.lock() {
            logger.set_log_file_path(path);
        }
    }
}

pub fn get_logs() -> Vec<LogEntry> {
    if let Some(logger) = LOGGER.get() {
        if let Ok(logger) = logger.lock() {
            return logger.get_logs();
        }
    }
    Vec::new()
}

pub fn clear_logs() {
    if let Some(logger) = LOGGER.get() {
        if let Ok(mut logger) = logger.lock() {
            logger.clear_logs();
        }
    }
}

pub fn log_with_context(level: LogLevel, component: &str, message: &str, context: Option<HashMap<String, serde_json::Value>>) {
    if let Some(logger) = LOGGER.get() {
        if let Ok(mut logger) = logger.lock() {
            logger.log(level, component, message, context);
        }
    }
}

#[macro_export]
macro_rules! log_debug {
    ($component:expr, $($arg:tt)*) => {
        $crate::logging::log_with_context(
            $crate::logging::LogLevel::Debug,
            $component,
            &format!($($arg)*),
            None
        );
    };
    ($component:expr, $message:expr, $context:expr) => {
        $crate::logging::log_with_context(
            $crate::logging::LogLevel::Debug,
            $component,
            $message,
            Some($context)
        );
    };
}

#[macro_export]
macro_rules! log_info {
    ($component:expr, $($arg:tt)*) => {
        $crate::logging::log_with_context(
            $crate::logging::LogLevel::Info,
            $component,
            &format!($($arg)*),
            None
        );
    };
    ($component:expr, $message:expr, $context:expr) => {
        $crate::logging::log_with_context(
            $crate::logging::LogLevel::Info,
            $component,
            $message,
            Some($context)
        );
    };
}

#[macro_export]
macro_rules! log_warn {
    ($component:expr, $($arg:tt)*) => {
        $crate::logging::log_with_context(
            $crate::logging::LogLevel::Warn,
            $component,
            &format!($($arg)*),
            None
        );
    };
    ($component:expr, $message:expr, $context:expr) => {
        $crate::logging::log_with_context(
            $crate::logging::LogLevel::Warn,
            $component,
            $message,
            Some($context)
        );
    };
}

#[macro_export]
macro_rules! log_error {
    ($component:expr, $($arg:tt)*) => {
        $crate::logging::log_with_context(
            $crate::logging::LogLevel::Error,
            $component,
            &format!($($arg)*),
            None
        );
    };
    ($component:expr, $message:expr, $context:expr) => {
        $crate::logging::log_with_context(
            $crate::logging::LogLevel::Error,
            $component,
            $message,
            Some($context)
        );
    };
}

#[macro_export]
macro_rules! log_critical {
    ($component:expr, $($arg:tt)*) => {
        $crate::logging::log_with_context(
            $crate::logging::LogLevel::Critical,
            $component,
            &format!($($arg)*),
            None
        );
    };
    ($component:expr, $message:expr, $context:expr) => {
        $crate::logging::log_with_context(
            $crate::logging::LogLevel::Critical,
            $component,
            $message,
            Some($context)
        );
    };
}
