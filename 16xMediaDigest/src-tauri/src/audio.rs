//! FFmpeg audio extraction — Tauri command.
//!
//! Converts any audio/video file into the exact format whisper.cpp requires:
//! 16 kHz, mono, 16-bit PCM WAV. Runs ffmpeg as a child process (never blocks
//! the webview) and streams progress to the frontend via Tauri events.
//!
//! Frontend contract:
//!   invoke("extract_audio", { inputPath, jobId }) -> Promise<ExtractResult>
//!   listen("extract://progress", { jobId, percent })
//!
//! Register in main.rs / lib.rs:
//!   tauri::Builder::default()
//!       .invoke_handler(tauri::generate_handler![audio::extract_audio])

use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractResult {
    pub wav_path: String,
    /// media duration in seconds (from ffprobe)
    pub duration_secs: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload<'a> {
    job_id: &'a str,
    percent: f32,
}

/// Resolve the ffmpeg/ffprobe binary. Prefer a bundled sidecar
/// (`src-tauri/binaries/ffmpeg-<target-triple>`), fall back to PATH
/// (Homebrew: `brew install ffmpeg`).
fn resolve_bin(app: &AppHandle, name: &str) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("binaries").join(name);
        if bundled.exists() {
            return bundled;
        }
    }
    PathBuf::from(name) // rely on PATH
}

/// Probe media duration in seconds; needed to turn ffmpeg's `out_time_us`
/// into a percentage.
async fn probe_duration(app: &AppHandle, input: &str) -> Result<f64, String> {
    let output = Command::new(resolve_bin(app, "ffprobe"))
        .args([
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            input,
        ])
        .output()
        .await
        .map_err(|e| format!("failed to run ffprobe: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .map_err(|e| format!("could not parse duration: {e}"))
}

/// Extract a whisper-ready WAV. Emits `extract://progress` events keyed by
/// `job_id` so the UI can drive its progress bar without polling.
#[tauri::command]
pub async fn extract_audio(
    app: AppHandle,
    input_path: String,
    job_id: String,
) -> Result<ExtractResult, String> {
    let duration = probe_duration(&app, &input_path).await?;

    // Output next to the app's cache: <cache>/digest/<job_id>.wav
    let out_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("digest");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let wav_path = out_dir.join(format!("{job_id}.wav"));

    let mut child = Command::new(resolve_bin(&app, "ffmpeg"))
        .args([
            "-hide_banner",
            "-nostats",
            "-y",                       // overwrite
            "-i", &input_path,
            "-vn",                      // drop video stream
            "-ac", "1",                 // mono
            "-ar", "16000",             // 16 kHz — required by whisper.cpp
            "-c:a", "pcm_s16le",        // 16-bit PCM WAV
            "-progress", "pipe:1",      // machine-readable progress on stdout
        ])
        .arg(&wav_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn ffmpeg (is it installed?): {e}"))?;

    // Parse `key=value` progress lines; emit percent on every out_time tick.
    let stdout = child.stdout.take().expect("stdout piped");
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(us) = line.strip_prefix("out_time_us=") {
            if let Ok(us) = us.trim().parse::<f64>() {
                let percent = ((us / 1_000_000.0) / duration * 100.0).clamp(0.0, 100.0) as f32;
                let _ = app.emit("extract://progress", ProgressPayload { job_id: &job_id, percent });
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("ffmpeg wait failed: {e}"))?;
    if !status.success() {
        return Err(format!("ffmpeg exited with {status}"));
    }

    let _ = app.emit("extract://progress", ProgressPayload { job_id: &job_id, percent: 100.0 });

    Ok(ExtractResult {
        wav_path: wav_path.to_string_lossy().into_owned(),
        duration_secs: duration,
    })
}
