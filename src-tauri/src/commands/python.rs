use crate::{log_info, log_warn};
use tauri::{AppHandle, Window, Emitter, Manager};

#[tauri::command]
pub async fn save_pth_model(
    app: AppHandle,
    file_name: String,
    base64_data: String,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD as Base64Engine, Engine};
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // Create pythonenv/models directory if it doesn't exist
    let model_dir = app_data_dir.join("pythonenv").join("models");
    fs::create_dir_all(&model_dir)
        .map_err(|e| format!("Failed to create model directory: {}", e))?;

    // Decode base64 data
    let file_data = Base64Engine
        .decode(&base64_data)
        .map_err(|e| format!("Failed to decode base64 data: {}", e))?;

    // Save file with original name
    let file_path = model_dir.join(&file_name);
    fs::write(&file_path, file_data).map_err(|e| format!("Failed to write model file: {}", e))?;

    log_info!("ModelManager", "Model file saved: {:?}", file_path);
    Ok(())
}

#[tauri::command]
pub async fn get_pth_models(app: AppHandle) -> Result<Vec<String>, String> {
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let model_dir = app_data_dir.join("pythonenv").join("models");

    // Check if directory exists
    if !model_dir.exists() {
        return Ok(Vec::new());
    }

    // Read directory contents
    let entries =
        fs::read_dir(&model_dir).map_err(|e| format!("Failed to read models directory: {}", e))?;

    let mut models = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_file() {
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                // Only include .pth files
                if file_name.ends_with(".pth") {
                    models.push(file_name.to_string());
                }
            }
        }
    }

    // Sort models for consistent ordering
    models.sort();
    Ok(models)
}

#[tauri::command]
pub async fn delete_pth_model(app: AppHandle, file_name: String) -> Result<(), String> {
    use std::fs;

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let file_path = app_data_dir
        .join("pythonenv")
        .join("models")
        .join(&file_name);

    // Check if file exists
    if !file_path.exists() {
        return Err(format!("Model file does not exist: {}", file_name));
    }

    // Check if it's a .pth file for security
    if !file_name.ends_with(".pth") {
        return Err("Only .pth model files can be deleted".to_string());
    }

    // Delete the file
    fs::remove_file(&file_path).map_err(|e| format!("Failed to delete model file: {}", e))?;

    log_info!("ModelManager", "Model file deleted: {:?}", file_path);
    Ok(())
}

#[tauri::command]
pub async fn setup_python_environment(
    app: AppHandle,
    window: Window,
) -> Result<serde_json::Value, String> {
    use std::fs;
    use std::process::Command;

    log_info!(
        "PythonEnvironment",
        "Starting comprehensive Python environment setup..."
    );

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // Step 1: Check if Python is installed and version >= 3.10
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 10,
                "status": "Checking Python installation and version..."
            }),
        )
        .unwrap();
    log_info!(
        "PythonEnvironment",
        "Step 1: Checking Python installation and version..."
    );

    let python_command = if cfg!(windows) { "python" } else { "python3" };

    let python_check = Command::new(python_command)
        .arg("--version")
        .output()
        .map_err(|e| {
            format!(
                "Python not found. Please install Python 3.10 or higher. Error: {}",
                e
            )
        })?;

    if !python_check.status.success() {
        return Err("Python not found. Please install Python 3.10 or higher.".to_string());
    }

    let version_output = String::from_utf8_lossy(&python_check.stdout);
    log_info!(
        "PythonEnvironment",
        "Found Python: {}",
        version_output.trim()
    );

    let version_string = version_output.trim().replace("Python ", "");
    let version_parts: Vec<&str> = version_string.split('.').collect();

    if version_parts.len() >= 2 {
        let major: i32 = version_parts[0].parse().unwrap_or(0);
        let minor: i32 = version_parts[1].parse().unwrap_or(0);

        if major < 3 || (major == 3 && minor < 10) {
            return Err(format!(
                "Python version {}.{} found, but version 3.10 or higher is required.",
                major, minor
            ));
        }
    }

    // Step 2: Create pythonenv directory in app data directory
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 25,
                "status": "Creating pythonenv directory..."
            }),
        )
        .unwrap();
    log_info!(
        "PythonEnvironment",
        "Step 2: Creating pythonenv directory in app data..."
    );

    let pythonenv_dir = app_data_dir.join("pythonenv");
    fs::create_dir_all(&pythonenv_dir)
        .map_err(|e| format!("Failed to create pythonenv directory: {}", e))?;

    // Step 3: Create virtual environment
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 40,
                "status": "Creating Python virtual environment..."
            }),
        )
        .unwrap();
    log_info!(
        "PythonEnvironment",
        "Step 3: Creating Python virtual environment..."
    );

    let venv_creation = Command::new(python_command)
        .args(["-m", "venv", pythonenv_dir.to_str().unwrap()])
        .output()
        .map_err(|e| format!("Failed to create virtual environment: {}", e))?;

    if !venv_creation.status.success() {
        let error_output = String::from_utf8_lossy(&venv_creation.stderr);
        return Err(format!(
            "Failed to create virtual environment: {}",
            error_output
        ));
    }

    // Step 4: Determine pip path based on OS
    let pip_path = if cfg!(windows) {
        pythonenv_dir.join("Scripts").join("pip.exe")
    } else {
        pythonenv_dir.join("bin").join("pip")
    };

    // Step 4: Install edge-tts
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 60,
                "status": "Installing edge-tts package..."
            }),
        )
        .unwrap();
    log_info!("PythonEnvironment", "Step 4: Installing edge-tts...");

    let edge_tts_install = Command::new(&pip_path)
        .args(["install", "edge-tts"])
        .output()
        .map_err(|e| format!("Failed to install edge-tts: {}", e))?;

    if !edge_tts_install.status.success() {
        let error_output = String::from_utf8_lossy(&edge_tts_install.stderr);
        return Err(format!("Failed to install edge-tts: {}", error_output));
    }

    // Step 5: Install PyTorch with CUDA 118 support
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 70,
                "status": "Installing PyTorch with CUDA 118 support..."
            }),
        )
        .unwrap();
    log_info!(
        "PythonEnvironment",
        "Step 5: Installing PyTorch with CUDA 118..."
    );

    // Install torch with specific version and CUDA support
    let torch_install = Command::new(&pip_path)
        .args([
            "install",
            "torch==2.1.1+cu118",
            "--index-url",
            "https://download.pytorch.org/whl/cu118",
        ])
        .output()
        .map_err(|e| format!("Failed to install torch: {}", e))?;

    if !torch_install.status.success() {
        let error_output = String::from_utf8_lossy(&torch_install.stderr);
        return Err(format!("Failed to install torch: {}", error_output));
    }

    // Step 6: Install torchaudio with CUDA 118 support
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 80,
                "status": "Installing torchaudio with CUDA 118 support..."
            }),
        )
        .unwrap();
    log_info!(
        "PythonEnvironment",
        "Step 6: Installing torchaudio with CUDA 118..."
    );

    let torchaudio_install = Command::new(&pip_path)
        .args([
            "install",
            "torchaudio==2.1.1+cu118",
            "--index-url",
            "https://download.pytorch.org/whl/cu118",
        ])
        .output()
        .map_err(|e| format!("Failed to install torchaudio: {}", e))?;

    if !torchaudio_install.status.success() {
        let error_output = String::from_utf8_lossy(&torchaudio_install.stderr);
        return Err(format!("Failed to install torchaudio: {}", error_output));
    }

    // Step 7: Install rvc-python
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 90,
                "status": "Installing rvc-python package..."
            }),
        )
        .unwrap();
    log_info!("PythonEnvironment", "Step 7: Installing rvc-python...");

    let rvc_python_install = Command::new(&pip_path)
        .args(["install", "rvc-python"])
        .output()
        .map_err(|e| format!("Failed to install rvc-python: {}", e))?;

    if !rvc_python_install.status.success() {
        let error_output = String::from_utf8_lossy(&rvc_python_install.stderr);
        return Err(format!("Failed to install rvc-python: {}", error_output));
    }

    // Final step: Complete
    window
        .emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": 100,
                "status": "Environment setup completed successfully!"
            }),
        )
        .unwrap();
    log_info!(
        "PythonEnvironment",
        "Python environment setup completed successfully!"
    );

    // Return success status with installed packages
    Ok(serde_json::json!({
        "success": true,
        "python_version": version_output.trim(),
        "virtual_env_path": pythonenv_dir.to_string_lossy(),
        "installed_packages": ["edge-tts", "torch==2.1.1+cu118", "torchaudio==2.1.1+cu118", "rvc-python"],
        "message": "Python environment setup completed successfully!"
    }))
}

#[tauri::command]
pub async fn check_environment_status(app: AppHandle) -> Result<serde_json::Value, String> {
    use std::path::Path;
    use std::process::Command;

    log_info!("PythonEnvironment", "Checking environment status...");

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // Check if virtual environment exists in app data directory
    let pythonenv_path = app_data_dir.join("pythonenv");
    let env_exists = pythonenv_path.exists();

    if !env_exists {
        return Ok(serde_json::json!({
            "environment_ready": false,
            "python_version": null,
            "library_versions": null,
            "message": "Virtual environment not found"
        }));
    }

    // Check Python version
    let python_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("python.exe")
    } else {
        pythonenv_path.join("bin").join("python")
    };

    let python_version = match Command::new(&python_path).arg("--version").output() {
        Ok(output) => {
            if output.status.success() {
                let version_output = String::from_utf8_lossy(&output.stdout);
                Some(format!("{} (Virtual Environment)", version_output.trim()))
            } else {
                None
            }
        }
        Err(_) => None,
    };

    // Check library versions
    let library_versions = get_library_versions_internal_with_path(&pythonenv_path).await;

    // Check if environment is truly ready - need all required libraries installed
    let environment_ready = if python_version.is_some() && library_versions.is_ok() {
        let libs = library_versions.as_ref().unwrap();
        let required_libs = ["rvc-python", "edge-tts", "torch", "torchaudio"];

        required_libs.iter().all(|&lib| {
            if let Some(version) = libs.get(lib).and_then(|v| v.as_str()) {
                version != "not installed"
            } else {
                false
            }
        })
    } else {
        false
    };

    log_info!(
        "PythonEnvironment",
        "Environment check - Ready: {}, Python: {}, Libraries: {:?}",
        environment_ready,
        python_version.is_some(),
        library_versions.is_ok()
    );

    // Generate informative message
    let message = if environment_ready {
        "Environment is ready".to_string()
    } else if python_version.is_none() {
        "Python virtual environment not found".to_string()
    } else if library_versions.is_err() {
        "Failed to check library versions".to_string()
    } else {
        let libs = library_versions.as_ref().unwrap();
        let required_libs = ["rvc-python", "edge-tts", "torch", "torchaudio"];
        let missing_libs: Vec<&str> = required_libs
            .iter()
            .filter(|&&lib| {
                if let Some(version) = libs.get(lib).and_then(|v| v.as_str()) {
                    version == "not installed"
                } else {
                    true
                }
            })
            .copied()
            .collect();

        if missing_libs.is_empty() {
            "Environment needs setup".to_string()
        } else {
            format!("Missing libraries: {}", missing_libs.join(", "))
        }
    };

    Ok(serde_json::json!({
        "environment_ready": environment_ready,
        "python_version": python_version,
        "library_versions": library_versions.unwrap_or_else(|_| serde_json::json!({})),
        "message": message
    }))
}

async fn get_library_versions_internal_with_path(
    pythonenv_path: &std::path::Path,
) -> Result<serde_json::Value, String> {
    use std::fs;
    use std::process::Command;

    // Check Python version
    let python_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("python.exe")
    } else {
        pythonenv_path.join("bin").join("python")
    };

    if !python_path.exists() {
        return Err("Python executable not found in virtual environment".to_string());
    }

    // Create a temporary Python script to check package versions
    let script_content = r#"
import json, subprocess, sys
def v(p, i):
    r = subprocess.run([sys.executable, "-m", "pip", "show", p], stdout=subprocess.PIPE, text=True)
    for l in r.stdout.splitlines():
        if l.lower().startswith("version:"): return l.split(":",1)[1].strip()
    try:
        return __import__(i).__version__
    except: return "not installed"
print(json.dumps({"rvc-python":v("rvc-python","rvc"),"edge-tts":v("edge-tts","edge_tts"),"torch":v("torch","torch"),"torchaudio":v("torchaudio","torchaudio")}, indent=2))
"#;

    // Write the script to a temporary file in the pythonenv directory
    let temp_script = pythonenv_path.join("check_versions_temp.py");
    fs::write(&temp_script, script_content)
        .map_err(|e| format!("Failed to write temporary script: {}", e))?;

    // Execute the script
    let output = Command::new(&python_path)
        .arg(&temp_script)
        .output()
        .map_err(|e| format!("Failed to execute version check script: {}", e))?;

    // Clean up the temporary file
    let _ = fs::remove_file(&temp_script);

    if output.status.success() {
        let output_str = String::from_utf8_lossy(&output.stdout);
        match serde_json::from_str::<serde_json::Value>(&output_str) {
            Ok(json_value) => Ok(json_value),
            Err(e) => Err(format!("Failed to parse JSON output: {}", e)),
        }
    } else {
        let error_output = String::from_utf8_lossy(&output.stderr);
        Err(format!("Script execution failed: {}", error_output))
    }
}

async fn get_library_versions_internal() -> Result<serde_json::Value, String> {
    use std::fs;
    use std::process::Command;

    // Get the AppData directory
    let data_dir = match dirs::data_dir() {
        Some(dir) => dir,
        None => return Err("Could not determine data directory".to_string()),
    };
    let pythonenv_path = data_dir.join("vocalix-v2").join("pythonenv");

    let python_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("python.exe")
    } else {
        pythonenv_path.join("bin").join("python")
    };

    if !python_path.exists() {
        return Err("Python executable not found in virtual environment".to_string());
    }

    // Create a temporary Python script to check package versions
    let script_content = r#"
import json, subprocess, sys
def v(p, i):
    r = subprocess.run([sys.executable, "-m", "pip", "show", p], stdout=subprocess.PIPE, text=True)
    for l in r.stdout.splitlines():
        if l.lower().startswith("version:"): return l.split(":",1)[1].strip()
    try:
        return __import__(i).__version__
    except: return "not installed"
print(json.dumps({"rvc-python":v("rvc-python","rvc"),"edge-tts":v("edge-tts","edge_tts"),"torch":v("torch","torch"),"torchaudio":v("torchaudio","torchaudio")}, indent=2))
"#;

    // Write the script to a temporary file in the pythonenv directory
    let temp_script = pythonenv_path.join("check_versions_temp.py");
    fs::write(&temp_script, script_content)
        .map_err(|e| format!("Failed to write temporary script: {}", e))?;

    // Execute the script
    let output = Command::new(&python_path)
        .arg(&temp_script)
        .output()
        .map_err(|e| format!("Failed to execute version check script: {}", e))?;

    // Clean up the temporary file
    let _ = fs::remove_file(&temp_script);

    if output.status.success() {
        let output_str = String::from_utf8_lossy(&output.stdout);
        match serde_json::from_str::<serde_json::Value>(&output_str) {
            Ok(json_value) => Ok(json_value),
            Err(e) => Err(format!("Failed to parse JSON output: {}", e)),
        }
    } else {
        let error_output = String::from_utf8_lossy(&output.stderr);
        Err(format!("Script execution failed: {}", error_output))
    }
}

#[tauri::command]
pub async fn check_python_version(app: AppHandle) -> Result<String, String> {
    use std::process::Command;

    log_info!("PythonEnvironment", "Checking Python version...");

    let python_command = if cfg!(windows) { "python" } else { "python3" };

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // First try using the virtual environment if it exists in app data
    let pythonenv_path = app_data_dir.join("pythonenv");
    let python_path = if pythonenv_path.exists() {
        if cfg!(windows) {
            pythonenv_path.join("Scripts").join("python.exe")
        } else {
            pythonenv_path.join("bin").join("python")
        }
    } else {
        // Fall back to system Python
        std::path::PathBuf::from(python_command)
    };

    // Execute python --version
    let version_check = Command::new(&python_path).arg("--version").output();

    match version_check {
        Ok(output) => {
            if output.status.success() {
                let version_output = String::from_utf8_lossy(&output.stdout);
                let version_str = version_output.trim();
                log_info!("PythonVersion", "Found Python: {}", version_str);

                // Add environment info
                let env_info =
                    if pythonenv_path.exists() && python_path.starts_with(&pythonenv_path) {
                        " (Virtual Environment)"
                    } else {
                        " (System)"
                    };

                Ok(format!("{}{}", version_str, env_info))
            } else {
                // Try system Python if virtual environment failed
                if pythonenv_path.exists() && python_path.starts_with(&pythonenv_path) {
                    log_info!(
                        "PythonVersion",
                        "Virtual environment Python failed, trying system Python..."
                    );

                    let system_check = Command::new(python_command).arg("--version").output();

                    match system_check {
                        Ok(output) => {
                            if output.status.success() {
                                let version_output = String::from_utf8_lossy(&output.stdout);
                                Ok(format!("{} (System)", version_output.trim()))
                            } else {
                                Err("Python version check failed".to_string())
                            }
                        }
                        Err(e) => Err(format!("Failed to execute Python: {}", e)),
                    }
                } else {
                    let error_output = String::from_utf8_lossy(&output.stderr);
                    Err(format!("Python version check failed: {}", error_output))
                }
            }
        }
        Err(e) => {
            // Try system Python if virtual environment failed
            if pythonenv_path.exists() && python_path.starts_with(&pythonenv_path) {
                log_info!(
                    "PythonVersion",
                    "Virtual environment Python failed, trying system Python..."
                );

                let system_check = Command::new(python_command).arg("--version").output();

                match system_check {
                    Ok(output) => {
                        if output.status.success() {
                            let version_output = String::from_utf8_lossy(&output.stdout);
                            Ok(format!("{} (System)", version_output.trim()))
                        } else {
                            Err("System Python version check failed".to_string())
                        }
                    }
                    Err(e) => Err(format!("Python not found: {}", e)),
                }
            } else {
                Err(format!("Failed to execute Python: {}", e))
            }
        }
    }
}

#[tauri::command]
pub async fn check_library_versions(app: AppHandle) -> Result<serde_json::Value, String> {
    log_info!("PythonEnvironment", "Checking library versions...");

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let pythonenv_path = app_data_dir.join("pythonenv");
    get_library_versions_internal_with_path(&pythonenv_path).await
}

#[tauri::command]
pub async fn get_available_devices(app: AppHandle) -> Result<serde_json::Value, String> {
    use std::fs;
    use std::process::Command;

    log_info!("PythonEnvironment", "Getting available devices...");

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let pythonenv_path = app_data_dir.join("pythonenv");
    let python_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("python.exe")
    } else {
        pythonenv_path.join("bin").join("python")
    };

    if !python_path.exists() {
        return Err("Python executable not found in virtual environment".to_string());
    }

    // Create a temporary Python script to check available devices
    let script_content = r#"
try:
    import torch
    import json
    devices = []
    for i in range(torch.cuda.device_count()):
        devices.append({'type': 'cuda', 'name': torch.cuda.get_device_name(i)})
    devices.append({'type': 'cpu', 'name': 'CPU'})
    print(json.dumps(devices))
except ImportError:
    import json
    print(json.dumps([{'type': 'cpu', 'name': 'CPU'}]))
"#;

    // Write the script to a temporary file in the pythonenv directory
    let temp_script = pythonenv_path.join("get_devices_temp.py");
    fs::write(&temp_script, script_content)
        .map_err(|e| format!("Failed to write temporary script: {}", e))?;

    // Execute the script
    let output = Command::new(&python_path)
        .arg(&temp_script)
        .output()
        .map_err(|e| format!("Failed to execute device check script: {}", e))?;

    // Clean up the temporary file
    let _ = fs::remove_file(&temp_script);

    if output.status.success() {
        let output_str = String::from_utf8_lossy(&output.stdout);
        match serde_json::from_str::<serde_json::Value>(&output_str) {
            Ok(json_value) => Ok(json_value),
            Err(e) => Err(format!("Failed to parse JSON output: {}", e)),
        }
    } else {
        let error_output = String::from_utf8_lossy(&output.stderr);
        Err(format!("Script execution failed: {}", error_output))
    }
}

#[tauri::command]
pub async fn install_dependencies() -> Result<(), String> {
    // TODO: Implement dependency installation
    println!("Installing dependencies...");
    Ok(())
}

#[tauri::command]
pub async fn download_models() -> Result<(), String> {
    // TODO: Implement model downloading
    println!("Downloading models...");
    Ok(())
}

#[tauri::command]
pub async fn force_reinstall_libraries(
    app: AppHandle,
    window: tauri::Window,
) -> Result<String, String> {
    use std::process::Command;

    log_info!(
        "PythonEnvironment",
        "Force reinstalling Python libraries..."
    );

    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let pythonenv_path = app_data_dir.join("pythonenv");

    if !pythonenv_path.exists() {
        return Err(
            "Virtual environment not found. Please set up the environment first.".to_string(),
        );
    }

    // Determine pip path
    let pip_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("pip.exe")
    } else {
        pythonenv_path.join("bin").join("pip")
    };

    // Emit progress updates
    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 10,
            "status": "Uninstalling existing packages..."
        }),
    );

    // Uninstall existing packages
    let packages = ["edge-tts", "rvc-python"];
    for (i, package) in packages.iter().enumerate() {
        let progress = 10 + (i as i32 * 20);
        let _ = window.emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": progress,
                "status": format!("Uninstalling {}...", package)
            }),
        );

        let uninstall_result = Command::new(&pip_path)
            .args(["uninstall", package, "-y"])
            .output();

        if let Err(e) = uninstall_result {
            log_warn!(
                "PythonEnvironment",
                "Failed to uninstall {}: {}",
                package,
                e
            );
        }
    }

    // Clear pip cache
    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 50,
            "status": "Clearing pip cache..."
        }),
    );

    let _ = Command::new(&pip_path).args(["cache", "purge"]).output();

    // Reinstall packages
    for (i, package) in packages.iter().enumerate() {
        let progress = 60 + (i as i32 * 20);
        let _ = window.emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": progress,
                "status": format!("Installing {}...", package)
            }),
        );

        let install_result = Command::new(&pip_path)
            .args(["install", "--force-reinstall", "--no-cache-dir", package])
            .output();

        match install_result {
            Ok(output) => {
                if !output.status.success() {
                    let error_output = String::from_utf8_lossy(&output.stderr);
                    return Err(format!("Failed to install {}: {}", package, error_output));
                }
            }
            Err(e) => {
                return Err(format!(
                    "Failed to execute pip install for {}: {}",
                    package, e
                ));
            }
        }
    }

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 100,
            "status": "Force reinstall completed successfully!"
        }),
    );

    Ok("Libraries force-reinstalled successfully".to_string())
}

#[tauri::command]
pub async fn reset_python_environment(app: AppHandle, window: tauri::Window) -> Result<String, String> {
    use std::fs;
    use std::process::Command;

    log_info!("PythonEnvironment", "Resetting Python environment...");

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let pythonenv_path = app_data_dir.join("pythonenv");

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 10,
            "status": "Removing existing virtual environment..."
        }),
    );

    // Remove existing virtual environment
    if pythonenv_path.exists() {
        if let Err(e) = fs::remove_dir_all(&pythonenv_path) {
            return Err(format!("Failed to remove existing environment: {}", e));
        }
    }

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 30,
            "status": "Creating fresh virtual environment..."
        }),
    );

    // Create fresh virtual environment
    let python_command = if cfg!(windows) { "python" } else { "python3" };
    let venv_result = Command::new(python_command)
        .args(["-m", "venv", pythonenv_path.to_str().unwrap()])
        .output();

    match venv_result {
        Ok(output) => {
            if !output.status.success() {
                let error_output = String::from_utf8_lossy(&output.stderr);
                return Err(format!(
                    "Failed to create virtual environment: {}",
                    error_output
                ));
            }
        }
        Err(e) => {
            return Err(format!("Failed to execute venv command: {}", e));
        }
    }

    // Set up pip path for package installation
    let pip_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("pip.exe")
    } else {
        pythonenv_path.join("bin").join("pip")
    };

    // Install required packages
    let packages = ["edge-tts", "rvc-python"];
    for (i, package) in packages.iter().enumerate() {
        let progress = 60 + (i as i32 * 20);
        let _ = window.emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": progress,
                "status": format!("Installing {}...", package)
            }),
        );

        let install_result = Command::new(&pip_path).args(["install", package]).output();

        match install_result {
            Ok(output) => {
                if !output.status.success() {
                    let error_output = String::from_utf8_lossy(&output.stderr);
                    return Err(format!("Failed to install {}: {}", package, error_output));
                }
            }
            Err(e) => {
                return Err(format!(
                    "Failed to execute pip install for {}: {}",
                    package, e
                ));
            }
        }
    }

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 100,
            "status": "Environment reset completed successfully!"
        }),
    );

    Ok("Python environment reset successfully".to_string())
}
