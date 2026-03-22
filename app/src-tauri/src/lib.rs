mod process;
mod skills;
mod workflows;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            skills::scan_skills,
            workflows::save_workflow,
            workflows::load_workflow,
            workflows::list_workflows,
            workflows::delete_workflow,
            process::discover_sessions,
            process::launch_claude,
            process::kill_session,
            process::update_session_workflow,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
