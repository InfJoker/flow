mod process;
mod settings;
mod skills;
mod workflows;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            settings::init_state(app);
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
            settings::load_update_settings,
            settings::save_update_settings,
            settings::check_for_update,
            settings::download_and_install_update,
            settings::list_github_releases,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
