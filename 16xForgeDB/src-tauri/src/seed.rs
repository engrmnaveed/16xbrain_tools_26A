//! Component D (Rust side) — maximum-throughput SQLite bridge.
//!
//! One IPC round-trip per 10k-row batch; rusqlite reuses a single prepared
//! statement (`prepare_cached`) inside one transaction per batch. SQLite's
//! real bottleneck is the per-transaction fsync, and we pay it once per batch.

use rusqlite::{params_from_iter, Connection};
use serde::Deserialize;
use std::sync::Mutex;

/// Mirrors the TS `RowBatch`.
#[derive(Deserialize)]
pub struct RowBatch {
    pub table: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

/// Mirrors the TS `FkPatch` (camelCase over IPC).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FkPatch {
    pub table: String,
    pub pk_column: String,
    pub fk_column: String,
    pub pairs: Vec<(serde_json::Value, serde_json::Value)>,
}

pub struct SeedDb(pub Mutex<Option<Connection>>);

fn ident(name: &str) -> Result<String, String> {
    if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && name
            .chars()
            .next()
            .map_or(false, |c| c.is_ascii_alphabetic() || c == '_')
    {
        Ok(format!("\"{name}\""))
    } else {
        Err(format!("unsafe identifier: {name}"))
    }
}

fn bind(v: &serde_json::Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as V;
    match v {
        serde_json::Value::Null => V::Null,
        serde_json::Value::Number(n) if n.is_i64() => V::Integer(n.as_i64().unwrap()),
        serde_json::Value::Number(n) => V::Real(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => V::Text(s.clone()),
        serde_json::Value::Bool(b) => V::Integer(*b as i64),
        other => V::Text(other.to_string()),
    }
}

#[tauri::command]
pub fn seed_open(state: tauri::State<SeedDb>, path: String, ddl: Vec<String>) -> Result<(), String> {
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = OFF;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -64000;
         PRAGMA foreign_keys = OFF;",
    )
    .map_err(|e| e.to_string())?;
    for stmt in ddl {
        conn.execute_batch(&stmt).map_err(|e| e.to_string())?;
    }
    *state.0.lock().unwrap() = Some(conn);
    Ok(())
}

#[tauri::command]
pub fn seed_write_batch(state: tauri::State<SeedDb>, batch: RowBatch) -> Result<usize, String> {
    let mut guard = state.0.lock().unwrap();
    let conn = guard.as_mut().ok_or("seed_open not called")?;

    let cols: Result<Vec<_>, _> = batch.columns.iter().map(|c| ident(c)).collect();
    let cols = cols?;
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        ident(&batch.table)?,
        cols.join(", "),
        vec!["?"; batch.columns.len()].join(",")
    );

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx.prepare_cached(&sql).map_err(|e| e.to_string())?;
        for row in &batch.rows {
            stmt.execute(params_from_iter(row.iter().map(bind)))
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(batch.rows.len())
}

#[tauri::command]
pub fn seed_apply_patch(state: tauri::State<SeedDb>, patch: FkPatch) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let conn = guard.as_mut().ok_or("seed_open not called")?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS _forge_patch (k PRIMARY KEY, v) WITHOUT ROWID;
         DELETE FROM _forge_patch;",
    )
    .map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare_cached("INSERT INTO _forge_patch (k, v) VALUES (?, ?)")
            .map_err(|e| e.to_string())?;
        for (k, v) in &patch.pairs {
            stmt.execute(params_from_iter([bind(k), bind(v)]))
                .map_err(|e| e.to_string())?;
        }
    }
    let (t, pk, fk) = (
        ident(&patch.table)?,
        ident(&patch.pk_column)?,
        ident(&patch.fk_column)?,
    );
    tx.execute(
        &format!(
            "UPDATE {t} SET {fk} = (SELECT v FROM _forge_patch WHERE k = {t}.{pk}) \
             WHERE {pk} IN (SELECT k FROM _forge_patch)"
        ),
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Restores safe pragmas and returns the number of FK violations (must be 0).
#[tauri::command]
pub fn seed_finalize(state: tauri::State<SeedDb>) -> Result<u64, String> {
    let mut guard = state.0.lock().unwrap();
    let conn = guard.as_mut().ok_or("seed_open not called")?;
    conn.execute_batch(
        "PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA optimize;",
    )
    .map_err(|e| e.to_string())?;
    let violations: u64 = conn
        .prepare("SELECT count(*) FROM pragma_foreign_key_check")
        .and_then(|mut s| s.query_row([], |r| r.get(0)))
        .map_err(|e| e.to_string())?;
    // Close the connection so the file is fully flushed and unlocked.
    *guard = None;
    Ok(violations)
}
