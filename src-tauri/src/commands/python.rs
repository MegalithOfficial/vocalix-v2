use crate::{log_info, log_warn};
use crate::helpers::create_hidden_command;
use tauri::{AppHandle, Emitter, Manager, Window};

#[tauri::command]
pub async fn save_pth_model(
    app: AppHandle,
    file_name: String,
    base64_data: String,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD as Base64Engine, Engine};
    use std::fs;

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let model_dir = app_data_dir.join("pythonenv").join("models");
    fs::create_dir_all(&model_dir)
        .map_err(|e| format!("Failed to create model directory: {}", e))?;

    let file_data = Base64Engine
        .decode(&base64_data)
        .map_err(|e| format!("Failed to decode base64 data: {}", e))?;

    let file_path = model_dir.join(&file_name);
    fs::write(&file_path, file_data).map_err(|e| format!("Failed to write model file: {}", e))?;

    log_info!("ModelManager", "Model file saved: {:?}", file_path);
    Ok(())
}

#[tauri::command]
pub async fn get_pth_models(app: AppHandle) -> Result<Vec<String>, String> {
    use std::fs;

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let model_dir = app_data_dir.join("pythonenv").join("models");

    if !model_dir.exists() {
        return Ok(Vec::new());
    }

    let entries =
        fs::read_dir(&model_dir).map_err(|e| format!("Failed to read models directory: {}", e))?;

    let mut models = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_file() {
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                if file_name.ends_with(".pth") {
                    models.push(file_name.to_string());
                }
            }
        }
    }

    models.sort();
    Ok(models)
}

#[tauri::command]
pub async fn delete_pth_model(app: AppHandle, file_name: String) -> Result<(), String> {
    use std::fs;

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let file_path = app_data_dir
        .join("pythonenv")
        .join("models")
        .join(&file_name);

    if !file_path.exists() {
        return Err(format!("Model file does not exist: {}", file_name));
    }

    if !file_name.ends_with(".pth") {
        return Err("Only .pth model files can be deleted".to_string());
    }

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
    // Command execution now uses hidden commands

    log_info!(
        "PythonEnvironment",
        "Starting comprehensive Python environment setup..."
    );

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

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

    let python_check = create_hidden_command(python_command)
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

    let venv_creation = create_hidden_command(python_command)
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

    let pip_path = if cfg!(windows) {
        pythonenv_dir.join("Scripts").join("pip.exe")
    } else {
        pythonenv_dir.join("bin").join("pip")
    };

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

    let edge_tts_install = create_hidden_command(&pip_path)
        .args(["install", "edge-tts"])
        .output()
        .map_err(|e| format!("Failed to install edge-tts: {}", e))?;

    if !edge_tts_install.status.success() {
        let error_output = String::from_utf8_lossy(&edge_tts_install.stderr);
        return Err(format!("Failed to install edge-tts: {}", error_output));
    }

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

    let torch_install = create_hidden_command(&pip_path)
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

    let torchaudio_install = create_hidden_command(&pip_path)
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

    let rvc_python_install = create_hidden_command(&pip_path)
        .args(["install", "rvc-python"])
        .output()
        .map_err(|e| format!("Failed to install rvc-python: {}", e))?;

    if !rvc_python_install.status.success() {
        let error_output = String::from_utf8_lossy(&rvc_python_install.stderr);
        return Err(format!("Failed to install rvc-python: {}", error_output));
    }

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
    // Command execution now uses hidden commands

    log_info!("PythonEnvironment", "Checking environment status...");

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

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

    let python_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("python.exe")
    } else {
        pythonenv_path.join("bin").join("python")
    };

    let python_version = match create_hidden_command(&python_path).arg("--version").output() {
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

    let library_versions = get_library_versions_internal_with_path(&pythonenv_path).await;

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
    

    let python_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("python.exe")
    } else {
        pythonenv_path.join("bin").join("python")
    };

    if !python_path.exists() {
        return Err("Python executable not found in virtual environment".to_string());
    }

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

    let temp_script = pythonenv_path.join("check_versions_temp.py");
    fs::write(&temp_script, script_content)
        .map_err(|e| format!("Failed to write temporary script: {}", e))?;

    let output = create_hidden_command(&python_path)
        .arg(&temp_script)
        .output()
        .map_err(|e| format!("Failed to execute version check script: {}", e))?;

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
    

    log_info!("PythonEnvironment", "Checking Python version...");

    let python_command = if cfg!(windows) { "python" } else { "python3" };

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let pythonenv_path = app_data_dir.join("pythonenv");
    let python_path = if pythonenv_path.exists() {
        if cfg!(windows) {
            pythonenv_path.join("Scripts").join("python.exe")
        } else {
            pythonenv_path.join("bin").join("python")
        }
    } else {
        std::path::PathBuf::from(python_command)
    };

    let version_check = create_hidden_command(&python_path).arg("--version").output();

    match version_check {
        Ok(output) => {
            if output.status.success() {
                let version_output = String::from_utf8_lossy(&output.stdout);
                let version_str = version_output.trim();
                log_info!("PythonVersion", "Found Python: {}", version_str);

                let env_info =
                    if pythonenv_path.exists() && python_path.starts_with(&pythonenv_path) {
                        " (Virtual Environment)"
                    } else {
                        " (System)"
                    };

                Ok(format!("{}{}", version_str, env_info))
            } else {
                if pythonenv_path.exists() && python_path.starts_with(&pythonenv_path) {
                    log_info!(
                        "PythonVersion",
                        "Virtual environment Python failed, trying system Python..."
                    );

                    let system_check = create_hidden_command(python_command).arg("--version").output();

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
            if pythonenv_path.exists() && python_path.starts_with(&pythonenv_path) {
                log_info!(
                    "PythonVersion",
                    "Virtual environment Python failed, trying system Python..."
                );

                let system_check = create_hidden_command(python_command).arg("--version").output();

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
    

    log_info!("PythonEnvironment", "Getting available devices...");

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

    let script_content = r#"import json; import sys; devices=[]; 
try: import torch; devices+=[{'type':'cuda','name':torch.cuda.get_device_name(i),'id':f'cuda:{i}'} for i in range(torch.cuda.device_count())]
except ImportError: pass
devices.append({'type':'cpu','name':'CPU','id':'cpu'}); print(json.dumps(devices))"#;

    let temp_script = pythonenv_path.join("get_devices_temp.py");
    fs::write(&temp_script, script_content)
        .map_err(|e| format!("Failed to write temporary script: {}", e))?;

    let output = create_hidden_command(&python_path)
        .arg(&temp_script)
        .output()
        .map_err(|e| format!("Failed to execute device check script: {}", e))?;

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
    println!("Installing dependencies...");
    Ok(())
}

#[tauri::command]
pub async fn download_models() -> Result<(), String> {
    println!("Downloading models...");
    Ok(())
}

#[tauri::command]
pub async fn force_reinstall_libraries(
    app: AppHandle,
    window: tauri::Window,
) -> Result<String, String> {
    

    log_info!(
        "PythonEnvironment",
        "Force reinstalling Python libraries..."
    );

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

    let pip_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("pip.exe")
    } else {
        pythonenv_path.join("bin").join("pip")
    };

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 10,
            "status": "Uninstalling existing packages..."
        }),
    );

    let packages = ["edge-tts", "rvc-python", "torch", "torchaudio"];
    for (i, package) in packages.iter().enumerate() {
        let progress = 10 + (i as i32 * 10);
        let _ = window.emit(
            "PYTHON_SETUP_PROGRESS",
            serde_json::json!({
                "progress": progress,
                "status": format!("Uninstalling {}...", package)
            }),
        );

        let uninstall_result = create_hidden_command(&pip_path)
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

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 50,
            "status": "Clearing pip cache..."
        }),
    );

    let _ = create_hidden_command(&pip_path).args(["cache", "purge"]).output();

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 60,
            "status": "Installing edge-tts..."
        }),
    );

    let install_result = create_hidden_command(&pip_path)
        .args(["install", "--force-reinstall", "--no-cache-dir", "edge-tts"])
        .output();

    match install_result {
        Ok(output) => {
            if !output.status.success() {
                let error_output = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Failed to install edge-tts: {}", error_output));
            }
        }
        Err(e) => {
            return Err(format!("Failed to execute pip install for edge-tts: {}", e));
        }
    }

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 70,
            "status": "Installing PyTorch with CUDA 118 support..."
        }),
    );

    let torch_install = create_hidden_command(&pip_path)
        .args([
            "install",
            "--force-reinstall",
            "--no-cache-dir",
            "torch==2.1.1+cu118",
            "torchaudio==2.1.1+cu118",
            "--index-url",
            "https://download.pytorch.org/whl/cu118",
        ])
        .output();

    match torch_install {
        Ok(output) => {
            if !output.status.success() {
                let error_output = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Failed to install PyTorch: {}", error_output));
            }
        }
        Err(e) => {
            return Err(format!("Failed to execute pip install for PyTorch: {}", e));
        }
    }

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 90,
            "status": "Installing rvc-python..."
        }),
    );

    let install_result = create_hidden_command(&pip_path)
        .args(["install", "--force-reinstall", "--no-cache-dir", "rvc-python"])
        .output();

    match install_result {
        Ok(output) => {
            if !output.status.success() {
                let error_output = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Failed to install rvc-python: {}", error_output));
            }
        }
        Err(e) => {
            return Err(format!("Failed to execute pip install for rvc-python: {}", e));
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
pub async fn reset_python_environment(
    app: AppHandle,
    window: tauri::Window,
) -> Result<String, String> {
    use std::fs;
    

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

    let python_command = if cfg!(windows) { "python" } else { "python3" };
    let venv_result = create_hidden_command(python_command)
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

    let pip_path = if cfg!(windows) {
        pythonenv_path.join("Scripts").join("pip.exe")
    } else {
        pythonenv_path.join("bin").join("pip")
    };

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 50,
            "status": "Installing edge-tts..."
        }),
    );

    let install_result = create_hidden_command(&pip_path).args(["install", "edge-tts"]).output();
    match install_result {
        Ok(output) => {
            if !output.status.success() {
                let error_output = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Failed to install edge-tts: {}", error_output));
            }
        }
        Err(e) => {
            return Err(format!("Failed to execute pip install for edge-tts: {}", e));
        }
    }

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 70,
            "status": "Installing PyTorch with CUDA 118 support..."
        }),
    );

    let torch_install = create_hidden_command(&pip_path)
        .args([
            "install",
            "torch==2.1.1+cu118",
            "torchaudio==2.1.1+cu118",
            "--index-url",
            "https://download.pytorch.org/whl/cu118",
        ])
        .output();

    match torch_install {
        Ok(output) => {
            if !output.status.success() {
                let error_output = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Failed to install PyTorch: {}", error_output));
            }
        }
        Err(e) => {
            return Err(format!("Failed to execute pip install for PyTorch: {}", e));
        }
    }

    let _ = window.emit(
        "PYTHON_SETUP_PROGRESS",
        serde_json::json!({
            "progress": 90,
            "status": "Installing rvc-python..."
        }),
    );

    let install_result = create_hidden_command(&pip_path).args(["install", "rvc-python"]).output();
    match install_result {
        Ok(output) => {
            if !output.status.success() {
                let error_output = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Failed to install rvc-python: {}", error_output));
            }
        }
        Err(e) => {
            return Err(format!("Failed to execute pip install for rvc-python: {}", e));
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

#[tauri::command]
pub async fn validate_server_requirements(app: AppHandle) -> Result<serde_json::Value, String> {
    let mut validation_result = serde_json::json!({
        "valid": true,
        "errors": [],
        "warnings": []
    });

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let pythonenv = app_data_dir.join("pythonenv");
    let python_exe = if cfg!(windows) {
        pythonenv.join("Scripts").join("python.exe")
    } else {
        pythonenv.join("bin").join("python")
    };

    if !python_exe.exists() {
        validation_result["valid"] = serde_json::Value::Bool(false);
        validation_result["errors"].as_array_mut().unwrap().push(serde_json::json!({
            "type": "python_env_missing",
            "message": "Python virtual environment not found. Please set up the Python environment first.",
            "action": "Go to Settings → Python Environment to set up the environment."
        }));
        return Ok(validation_result);
    }

    let required_libs = ["rvc-python", "edge-tts", "torch", "torchaudio"];
    let pip_path = if cfg!(windows) {
        pythonenv.join("Scripts").join("pip.exe")
    } else {
        pythonenv.join("bin").join("pip")
    };

    for lib in &required_libs {
        let check_output = create_hidden_command(&pip_path)
            .args(["show", lib])
            .output();

        match check_output {
            Ok(output) => {
                if !output.status.success() {
                    validation_result["valid"] = serde_json::Value::Bool(false);
                    validation_result["errors"].as_array_mut().unwrap().push(serde_json::json!({
                        "type": "library_missing",
                        "message": format!("Required library '{}' is not installed.", lib),
                        "action": "Go to Settings → Python Environment to install required libraries."
                    }));
                }
            }
            Err(_) => {
                validation_result["valid"] = serde_json::Value::Bool(false);
                validation_result["errors"].as_array_mut().unwrap().push(serde_json::json!({
                    "type": "pip_error",
                    "message": "Cannot verify library installations - pip is not accessible.",
                    "action": "Go to Settings → Python Environment to reinstall the environment."
                }));
                break;
            }
        }
    }

    match crate::commands::tts::load_tts_settings(app.clone()).await {
        Ok(tts_config) => {
            let tts_mode = tts_config.get("ttsMode").and_then(|v| v.as_str()).unwrap_or("normal");
            
            if tts_mode == "rvc" {
                let selected_model = tts_config.get("selectedModel").and_then(|v| v.as_str()).unwrap_or("");
                
                if selected_model.is_empty() {
                    validation_result["warnings"].as_array_mut().unwrap().push(serde_json::json!({
                        "type": "rvc_model_not_selected",
                        "message": "RVC mode is enabled but no model is selected.",
                        "action": "Go to Settings → Text to Speech to select an RVC model."
                    }));
                } else {
                    let model_path = pythonenv.join("models").join(selected_model);
                    if !model_path.exists() {
                        validation_result["valid"] = serde_json::Value::Bool(false);
                        validation_result["errors"].as_array_mut().unwrap().push(serde_json::json!({
                            "type": "rvc_model_missing",
                            "message": format!("Selected RVC model '{}' does not exist.", selected_model),
                            "action": "Go to Settings → Text to Speech to upload a valid RVC model or select a different one."
                        }));
                    }
                }
            }
        }
        Err(_) => {
            validation_result["warnings"].as_array_mut().unwrap().push(serde_json::json!({
                "type": "tts_config_missing",
                "message": "TTS configuration not found. Using default settings.",
                "action": "Go to Settings → Text to Speech to configure TTS settings."
            }));
        }
    }

    Ok(validation_result)
}
