mod claude_sessions;
mod launcher;
mod process;
mod project;
mod settings;
mod skills;
mod workflows;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            project::load_projects,
            project::open_project,
            project::remove_recent_project,
            claude_sessions::list_claude_sessions,
            launcher::start_session,
            settings::load_update_settings,
            settings::save_update_settings,
            settings::check_for_update,
            settings::download_and_install_update,
            settings::list_github_releases,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // Servers this app spawned are its responsibility. Without this they
            // are reparented to init on quit and keep running — holding a port,
            // a session file, and possibly a live Claude turn.
            if let tauri::RunEvent::Exit = event {
                launcher::reap_spawned_sessions();
            }
        });
}
