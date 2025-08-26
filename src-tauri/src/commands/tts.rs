use crate::{log_info, log_warn, log_error, log_debug, log_critical};
use crate::helpers::create_hidden_command;
use tauri::{AppHandle, Emitter, Manager};
use base64::{Engine as _, engine::general_purpose};

#[tauri::command]
pub async fn save_tts_settings(app: AppHandle, config: serde_json::Value) -> Result<(), String> {
    use std::fs;

    log_debug!("TTSSettings", "Saving TTS settings: {:?}", config);

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| {
            log_error!("TTSSettings", "Failed to get app data directory: {}", e);
            format!("Failed to get app data directory: {}", e)
        })?;

    fs::create_dir_all(&app_data_dir)
        .map_err(|e| {
            log_error!("TTSSettings", "Failed to create app data directory: {}", e);
            format!("Failed to create app data directory: {}", e)
        })?;

    let config_path = app_data_dir.join("texttospeech.json");

    let config_str = serde_json::to_string_pretty(&config)
        .map_err(|e| {
            log_error!("TTSSettings", "Failed to serialize config: {}", e);
            format!("Failed to serialize config: {}", e)
        })?;

    fs::write(&config_path, config_str)
        .map_err(|e| {
            log_error!("TTSSettings", "Failed to write TTS config: {}", e);
            format!("Failed to write TTS config: {}", e)
        })?;

    log_info!("TTSSettings", "TTS settings saved to {:?}", config_path);
    Ok(())
}

#[tauri::command]
pub async fn load_tts_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    use std::fs;

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let config_path = app_data_dir.join("texttospeech.json");

    match fs::read_to_string(&config_path) {
        Ok(content) => {
            let config: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse TTS config: {}", e))?;
            Ok(config)
        }
        Err(_) => {
            Ok(serde_json::json!({}))
        }
    }
}

fn venv_paths(app: &AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| {
            log_error!("TTS", "Failed to get app data directory for venv: {}", e);
            format!("Failed to get app data directory: {}", e)
        })?;
    let pythonenv = app_data_dir.join("pythonenv");
    let py = if cfg!(windows) {
        pythonenv.join("Scripts").join("python.exe")
    } else {
        pythonenv.join("bin").join("python")
    };
    if !py.exists() {
        log_critical!("TTS", "Python virtual environment not found at: {:?}", py);
        return Err("Python virtual environment not found. Please set up Python Environment.".to_string());
    }
    log_debug!("TTS", "Using Python venv: {:?}", py);
    Ok((pythonenv, py))
}

fn ensure_output_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    use std::fs;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    let out = app_data_dir.join("output");
    fs::create_dir_all(&out).map_err(|e| format!("Failed to create output dir: {}", e))?;
    Ok(out)
}

fn convert_path_for_cli(p: &std::path::Path) -> String { p.to_string_lossy().replace('\\', "/") }

#[tauri::command]
pub async fn generate_tts(
    app: AppHandle,
    mode: String,                
    text: String,
    voice: Option<String>,       
    model_file: Option<String>,   
    device: Option<String>,      
    inference_rate: Option<f64>,
    filter_radius: Option<i32>,
    resample_rate: Option<f64>,
    protect_rate: Option<f64>,
) -> Result<serde_json::Value, String> {

    let (pythonenv_dir, python_path) = venv_paths(&app)?;
    let output_dir = ensure_output_dir(&app)?;

    let uid = chrono::Utc::now().timestamp_millis();
    let tts_path = output_dir.join(format!("tts_{}.wav", uid));
    let rvc_path = output_dir.join(format!("converted_{}.wav", uid));

    app.emit("tts_status", serde_json::json!({"progress": 5, "status": "starting"})).ok();

    let v = voice.unwrap_or_else(|| "en-US-JennyNeural".to_string());
    let edge_args = [
        "-m", "edge_tts", "--voice", &v, "--text", &text, "--write-media",
        &convert_path_for_cli(&tts_path),
    ];
    app.emit("tts_status", serde_json::json!({"progress": 15, "status": "synthesizing (edge-tts)"})).ok();
    log_info!("TTS", "Running edge-tts: python {:?} {:?}", python_path, edge_args);
    let edge_status = create_hidden_command(&python_path)
        .args(&edge_args)
        .status()
        .map_err(|e| {
            app.emit("tts_status", serde_json::json!({"progress": 0, "status": format!("error_edge_tts: {}", e)})).ok();
            format!("Failed to execute edge-tts: {}", e)
        })?;
    if !edge_status.success() {
        app.emit("tts_status", serde_json::json!({"progress": 0, "status": "error_edge_tts"})).ok();
        return Err("Edge TTS conversion failed".into());
    }

    if mode == "normal" {
        app.emit("tts_status", serde_json::json!({"progress": 100, "status": "completed"})).ok();
        
        let audio_data = std::fs::read(&tts_path)
            .map_err(|e| format!("Failed to read audio file: {}", e))?;
        let base64_audio = general_purpose::STANDARD.encode(&audio_data);
        
        return Ok(serde_json::json!({
            "path": convert_path_for_cli(&tts_path),
            "audio_data": base64_audio,
            "mime_type": "audio/wav",
            "message": "Normal TTS generation completed",
        }));
    }

    app.emit("tts_status", serde_json::json!({"progress": 50, "status": "enhancing (rvc)"})).ok();
    let model = if let Some(m) = model_file { m } else {
        let cfg = load_tts_settings(app.clone()).await.unwrap_or_else(|_| serde_json::json!({}));
        cfg.get("selectedModel").and_then(|v| v.as_str()).unwrap_or("").to_string()
    };
    if model.is_empty() {
        log_warn!("TTS", "RVC mode requested but no model selected");
        app.emit("tts_status", serde_json::json!({"progress": 0, "status": "error_model_not_selected"})).ok();
        return Err("RVC model file not selected".to_string());
    }
    let model_path = pythonenv_dir.join("models").join(&model);
    if !model_path.exists() {
        app.emit("tts_status", serde_json::json!({"progress": 0, "status": "error_model_missing"})).ok();
        return Err(format!("Model not found: {}", model_path.display()));
    }

    let dev = device.unwrap_or_else(|| "cpu".to_string());
    let ir = inference_rate.unwrap_or(0.75);
    let fr = filter_radius.unwrap_or(3);
    let rmr = resample_rate.unwrap_or(0.25);
    let pr = protect_rate.unwrap_or(0.5);

    let mut rvc_args = vec![
        "-m".into(), "rvc_python".into(), "cli".into(),
        "-i".into(), convert_path_for_cli(&tts_path),
        "-o".into(), convert_path_for_cli(&rvc_path),
        "-mp".into(), convert_path_for_cli(&model_path),
    ];
    if dev.to_lowercase() != "cpu" {
        rvc_args.push("-de".into());
        rvc_args.push(dev);
    }
    rvc_args.extend(vec![
        "-ir".into(), format!("{}", ir),
        "-fr".into(), format!("{}", fr),
        "-rmr".into(), format!("{}", rmr),
        "-pr".into(), format!("{}", pr),
    ]);
    app.emit("tts_status", serde_json::json!({"progress": 60, "status": "converting (rvc)"})).ok();
    log_info!("TTS", "Running RVC: python -m rvc_python cli args: {:?}", rvc_args);
    let rvc_status = create_hidden_command(&python_path)
        .args(&rvc_args)
        .status()
        .map_err(|e| {
            app.emit("tts_status", serde_json::json!({"progress": 0, "status": format!("error_rvc: {}", e)})).ok();
            format!("Failed to execute rvc_python: {}", e)
        })?;
    if !rvc_status.success() {
        app.emit("tts_status", serde_json::json!({"progress": 0, "status": "error_rvc"})).ok();
        return Err("RVC conversion failed".into());
    }

    app.emit("tts_status", serde_json::json!({"progress": 100, "status": "completed"})).ok();
    
    let audio_data = std::fs::read(&rvc_path)
        .map_err(|e| format!("Failed to read RVC audio file: {}", e))?;
    let base64_audio = general_purpose::STANDARD.encode(&audio_data);
    
    Ok(serde_json::json!({
        "path": convert_path_for_cli(&rvc_path),
        "audio_data": base64_audio,
        "mime_type": "audio/wav",
        "message": "RVC TTS generation completed",
    }))
}

#[tauri::command]
pub async fn test_tts_normal(app: AppHandle, provider: String, voice: String) -> Result<(), String> {
    let _ = provider;
    generate_tts(
        app,
        "normal".into(),
        "This is a test of text to speech.".into(),
        Some(voice),
        None,
        None,
        None,
        None,
        None,
        None,
    ).await.map(|_| ())
}

#[tauri::command]
pub async fn test_tts_rvc(
    app: AppHandle,
    device: String,
    inference_rate: f64,
    filter_radius: i32,
    resample_rate: f64,
    protect_rate: f64,
) -> Result<(), String> {
    generate_tts(
        app,
        "rvc".into(),
        "This is a test of RVC voice conversion.".into(),
        Some("en-US-JennyNeural".into()),
        None,
        Some(device),
        Some(inference_rate),
        Some(filter_radius),
        Some(resample_rate),
        Some(protect_rate),
    ).await.map(|_| ())
}

#[derive(serde::Serialize, Debug)]
pub struct StaticTtsResult {
    pub absolute_path: String,
    pub relative_path: String,
    pub file_name: String,
    pub mime_type: String,
    pub message: String,
}

fn sanitize_component(input: &str) -> String {
    let mut out = String::new();
    let mut last_us = false;
    for ch in input.chars() {
        let ok = ch.is_ascii_alphanumeric() || ch == '_';
        if ok {
            out.push(ch);
            last_us = false;
        } else {
            if !last_us {
                out.push('_');
                last_us = true;
            }
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() { "default".to_string() } else { trimmed }
}

fn ensure_static_audios_dir(app: &tauri::AppHandle, redemption: &str) -> Result<std::path::PathBuf, String> {
    use std::fs;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    let dir = app_data_dir.join("static_audios").join(redemption);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create directory {:?}: {}", dir, e))?;
    Ok(dir)
}

fn timestamp_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}", now.as_millis())
}

#[tauri::command]
pub async fn generate_static_tts_file(
    app: tauri::AppHandle,
    redemption_name: String,
    text: String,
    voice: Option<String>,
    tts_mode: Option<String>,           // "normal"|"rvc"
    model_file: Option<String>,         // RVC only
    device: Option<String>,             // RVC optional overrides
    inference_rate: Option<f64>,
    filter_radius: Option<i32>,
    resample_rate: Option<f64>,
    protect_rate: Option<f64>,
    file_basename: Option<String>,      // used for naming
    format: Option<String>,             // default "mp3"; may fall back to "wav" in RVC if no transcoder
) -> Result<StaticTtsResult, String> {
    // Validate and sanitize inputs
    let mut trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        app.emit("tts_status", serde_json::json!({"progress": 0, "status": "error_empty_text"})).ok();
        return Err("Text cannot be empty".to_string());
    }
    if trimmed.chars().count() > 5000 {
        trimmed = trimmed.chars().take(5000).collect();
    }
    let safe_redemption = sanitize_component(&redemption_name);
    let safe_basename = sanitize_component(&file_basename.unwrap_or_else(|| "tts".to_string()));
    let want_format = format.unwrap_or_else(|| "mp3".to_string()).to_lowercase();

    let resolved_voice = if let Some(v) = voice {
        v
    } else {
        let cfg = load_tts_settings(app.clone()).await.unwrap_or_else(|_| serde_json::json!({}));
        cfg.get("selectedVoice")
            .and_then(|v| v.as_str())
            .unwrap_or("en-US-JennyNeural")
            .to_string()
    };

    // Ensure environment (python venv) exists as edge-tts / rvc live there
    let (_venv_dir, python_path) = match venv_paths(&app) {
        Ok(v) => v,
        Err(e) => {
            app.emit("tts_status", serde_json::json!({"progress": 0, "status": format!("error_env: {}", e)})).ok();
            return Err(e);
        }
    };

    let mode = tts_mode.unwrap_or_else(|| "normal".to_string());

    let dest_dir = ensure_static_audios_dir(&app, &safe_redemption)?;

    app.emit("tts_status", serde_json::json!({
        "progress": 5,
        "status": "start",
        "mode": mode,
        "voice": resolved_voice,
        "redemption": safe_redemption,
        "format": want_format
    })).ok();

    let ts = timestamp_suffix();

    if mode == "normal" {
        // Normal: synthesize directly to desired container via edge-tts
        let ext = if want_format == "wav" { "wav" } else { "mp3" };
        let file_name = format!("{}-{}.{}", safe_basename, ts, ext);
        let abs_path = dest_dir.join(&file_name);

        let edge_args = [
            "-m", "edge_tts",
            "--voice", &resolved_voice,
            "--text", &trimmed,
            "--write-media", &convert_path_for_cli(&abs_path),
        ];

        app.emit("tts_status", serde_json::json!({"progress": 15, "status": "edge_tts_start"})).ok();
        log_info!("TTS", "Running edge-tts: python {:?} {:?}", python_path, edge_args);

        let edge_status = create_hidden_command(&python_path)
            .args(&edge_args)
            .status()
            .map_err(|e| {
                app.emit("tts_status", serde_json::json!({"progress": 0, "status": format!("error_edge_tts: {}", e)})).ok();
                format!("Failed to execute edge-tts: {}", e)
            })?;
        if !edge_status.success() {
            app.emit("tts_status", serde_json::json!({"progress": 0, "status": "error_edge_tts"})).ok();
            return Err("Edge TTS conversion failed".into());
        }

        let rel_path = format!("static_audios/{}/{}", safe_redemption, file_name);
        let mime = if ext == "mp3" { "audio/mpeg" } else { "audio/wav" }.to_string();

        app.emit("tts_status", serde_json::json!({"progress": 100, "status": "done"})).ok();

        Ok(StaticTtsResult {
            absolute_path: abs_path.to_string_lossy().to_string(),
            relative_path: rel_path,
            file_name,
            mime_type: mime,
            message: "Normal TTS generation completed".to_string(),
        })
    } else {
        // RVC pipeline: use existing generate_tts for validation and conversion to WAV
        app.emit("tts_status", serde_json::json!({"progress": 50, "status": "rvc_start"})).ok();

        let rvc_json = generate_tts(
            app.clone(),
            "rvc".into(),
            trimmed.clone(),
            Some(resolved_voice.clone()),
            model_file.clone(),
            device.clone(),
            inference_rate,
            filter_radius,
            resample_rate,
            protect_rate,
        ).await?;

        let src_path_str = rvc_json.get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "RVC output did not return a path".to_string())?;
        let src_wav = std::path::PathBuf::from(src_path_str);
        if !src_wav.exists() {
            app.emit("tts_status", serde_json::json!({"progress": 0, "status": "error_rvc_missing_output"})).ok();
            return Err(format!("RVC output file does not exist: {}", src_wav.display()));
        }

        let wav_name = format!("{}-{}.wav", safe_basename, ts);
        let wav_dest = dest_dir.join(&wav_name);

        std::fs::copy(&src_wav, &wav_dest)
            .map_err(|e| format!("Failed to copy RVC output: {}", e))?;
        let _ = std::fs::remove_file(&src_wav);

        app.emit("tts_status", serde_json::json!({"progress": 75, "status": "rvc_converted"})).ok();

        // Optional transcode to MP3 if requested and ffmpeg is available
        if want_format == "mp3" {
            app.emit("tts_status", serde_json::json!({"progress": 80, "status": "transcoding"})).ok();

            let ffmpeg_check = create_hidden_command("ffmpeg").arg("-version").status();
            if let Ok(st) = ffmpeg_check {
                if st.success() {
                    let mp3_name = format!("{}-{}.mp3", safe_basename, ts);
                    let mp3_dest = dest_dir.join(&mp3_name);
                    let ff_status = create_hidden_command("ffmpeg")
                        .args([
                            "-y",
                            "-i",
                            &convert_path_for_cli(&wav_dest),
                            &convert_path_for_cli(&mp3_dest),
                        ])
                        .status();

                    match ff_status {
                        Ok(s) if s.success() => {
                            let _ = std::fs::remove_file(&wav_dest);
                            let rel_path = format!("static_audios/{}/{}", safe_redemption, mp3_name);
                            app.emit("tts_status", serde_json::json!({"progress": 100, "status": "done"})).ok();
                            return Ok(StaticTtsResult {
                                absolute_path: mp3_dest.to_string_lossy().to_string(),
                                relative_path: rel_path,
                                file_name: mp3_name,
                                mime_type: "audio/mpeg".to_string(),
                                message: "RVC TTS generation completed (mp3)".to_string(),
                            });
                        }
                        Ok(_) => {
                            app.emit("tts_status", serde_json::json!({"progress": 90, "status": "transcode_failed"})).ok();
                        }
                        Err(e) => {
                            app.emit("tts_status", serde_json::json!({"progress": 90, "status": format!("transcode_failed: {}", e)})).ok();
                        }
                    }
                } else {
                    app.emit("tts_status", serde_json::json!({"progress": 80, "status": "transcode_skipped"})).ok();
                }
            } else {
                app.emit("tts_status", serde_json::json!({"progress": 80, "status": "transcode_skipped"})).ok();
            }
        }

        let rel_path = format!("static_audios/{}/{}", safe_redemption, wav_name);
        app.emit("tts_status", serde_json::json!({"progress": 100, "status": "done"})).ok();

        Ok(StaticTtsResult {
            absolute_path: wav_dest.to_string_lossy().to_string(),
            relative_path: rel_path,
            file_name: wav_name,
            mime_type: "audio/wav".to_string(),
            message: "RVC TTS generation completed (wav)".to_string(),
        })
    }
}
