//! whisper.cpp transcription — Tauri command.
//!
//! Spawns `whisper-cli` against the 16kHz mono WAV produced by `audio.rs`,
//! parses its JSON output into `WhisperSegment[]`, and streams coarse
//! progress to the frontend via Tauri events.
//!
//! Frontend contract:
//!   invoke("transcribe_audio", { wavPath, jobId, modelPath, language }) -> Promise<TranscribeResult>
//!   listen("transcribe://progress", { jobId, percent })
//!
//! `language` is one of "auto" | "ur" | "en", matching whisper.cpp's `-l` flag.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperSegment {
    /// seconds
    pub start: f64,
    /// seconds
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeResult {
    pub segments: Vec<WhisperSegment>,
    pub detected_language: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload<'a> {
    job_id: &'a str,
    percent: f32,
}

// ---- whisper.cpp's `-oj` JSON output shape ----

#[derive(Debug, Deserialize)]
struct WhisperJsonOutput {
    #[serde(default)]
    result: Option<WhisperJsonResult>,
    #[serde(default)]
    transcription: Vec<WhisperJsonSegment>,
}

#[derive(Debug, Deserialize)]
struct WhisperJsonResult {
    #[serde(default)]
    language: String,
}

#[derive(Debug, Deserialize)]
struct WhisperJsonSegment {
    offsets: WhisperJsonOffsets,
    text: String,
}

#[derive(Debug, Deserialize)]
struct WhisperJsonOffsets {
    from: f64,
    to: f64,
}

fn resolve_bin(app: &AppHandle, name: &str) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("binaries").join(name);
        if bundled.exists() {
            return bundled;
        }
    }
    PathBuf::from(name) // rely on PATH (Homebrew: `brew install whisper-cpp`)
}

/// Parse a `--print-progress` line of the form `whisper_print_progress_callback: progress = 42%`.
fn parse_progress_percent(line: &str) -> Option<f32> {
    let idx = line.find("progress =")?;
    let rest = line[idx + "progress =".len()..].trim();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<f32>().ok()
}

/// Transcribe a WAV file. Emits `transcribe://progress` events keyed by
/// `job_id`, then returns the parsed segments plus detected language.
#[tauri::command]
pub async fn transcribe_audio(
    app: AppHandle,
    wav_path: String,
    job_id: String,
    model_path: String,
    language: String,
) -> Result<TranscribeResult, String> {
    let out_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("digest");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let out_prefix = out_dir.join(&job_id);
    let json_path = out_dir.join(format!("{job_id}.json"));

    let lang = if language.is_empty() { "auto".to_string() } else { language };

    let mut child = Command::new(resolve_bin(&app, "whisper-cli"))
        .args([
            "-m", &model_path,
            "-f", &wav_path,
            "-l", &lang,
            "-oj",                       // output JSON sidecar
            "-of", &out_prefix.to_string_lossy(),
            "--print-progress",
            "-nt",                       // no timestamps in stdout text (we read the JSON)
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn whisper-cli (is whisper-cpp installed?): {e}"))?;

    // whisper.cpp's progress prints go to stderr.
    let stderr = child.stderr.take().expect("stderr piped");
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(percent) = parse_progress_percent(&line) {
            let _ = app.emit(
                "transcribe://progress",
                ProgressPayload { job_id: &job_id, percent },
            );
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("whisper-cli wait failed: {e}"))?;
    if !status.success() {
        return Err(format!("whisper-cli exited with {status}"));
    }

    let raw = std::fs::read_to_string(&json_path)
        .map_err(|e| format!("failed to read whisper output {}: {e}", json_path.display()))?;
    let parsed: WhisperJsonOutput = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse whisper JSON output: {e}"))?;

    let segments = parsed
        .transcription
        .into_iter()
        .map(|s| WhisperSegment {
            start: s.offsets.from / 1000.0,
            end: s.offsets.to / 1000.0,
            text: s.text.trim().to_string(),
        })
        .collect();

    let detected_language = parsed.result.map(|r| r.language).unwrap_or_default();

    let _ = app.emit(
        "transcribe://progress",
        ProgressPayload { job_id: &job_id, percent: 100.0 },
    );

    Ok(TranscribeResult { segments, detected_language })
}
