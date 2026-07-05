//! User preferences: resolves `settings.json` in the app config dir (created
//! on first use). The file itself is read/written through the normal local
//! file commands, so the editor can open it like any other file.

use tauri::Manager;

#[tauri::command]
pub fn settings_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create config dir: {e}"))?;
    Ok(dir.join("settings.json").to_string_lossy().into_owned())
}
