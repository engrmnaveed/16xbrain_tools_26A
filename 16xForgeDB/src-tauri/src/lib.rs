mod seed;

use seed::SeedDb;
use std::sync::Mutex;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SeedDb(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            seed::seed_open,
            seed::seed_write_batch,
            seed::seed_apply_patch,
            seed::seed_finalize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ForgeDB");
}
