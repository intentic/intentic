/* The release build passes its version to `tauri build` as a config override (build-desktop.sh), which is what stamps the installer. */
fn main() {
    let version = std::env::var("INTENTIC_VERSION")
        .ok()
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| "0.0.0".to_string());
    println!("cargo:rustc-env=INTENTIC_VERSION={version}");
    println!("cargo:rerun-if-env-changed=INTENTIC_VERSION");
    // Every command this app registers (lib.rs), listed so each is a permission a capability must grant rather than
    // something any window may call. The local windows (the main one and each folder's, local.rs) are granted the
    // commands their shell and This device call (capabilities/local.json) and nothing else; the documents they draw
    // run no script of their own there, so only the app's own bundle can call even those.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("the app's command manifest builds");
}

const COMMANDS: &[&str] = &[
    "sign_in",
    "desktop_info",
    "docker_ready",
    "docker_listening",
    "docker_start",
    "docker_open",
    "hosts_sandboxes",
    "take_pending_docker",
    "take_pending_setup",
    "take_pending_recreate",
    "take_pending_fix",
    "sandbox_fix",
    "take_pending_sync",
    "sync_run",
    "folder_entries",
    "setup_run",
    "run_stop",
    "reveal_log",
    "open_url",
    "restart_for_setup",
    "sign_out_for_setup",
    "resumable_setup",
    "forget_resumable_setup",
    "sandbox_list",
    "sandbox_power",
    "sandbox_recreate",
    "sandbox_shape",
    "docker_engine",
    "sandbox_remove",
    "sandbox_logs",
    "machine_report",
    "machine_restart",
    "workspace_open",
    "home_facts",
    "setup_alert",
    "setup_progress",
    "fit_to_content",
    "close_workspace",
    "settings_get",
    "settings_set",
    "update_state",
    "update_install",
    "local_pick",
    "local_point",
    "local_open_path",
    "local_recents",
    "local_forget_recent",
    "local_roster",
    "account_relay",
    "project_preview",
    "project_attach",
    "machine_sandbox_status",
    "machine_sandbox_retry",
    "machine_sandbox_check",
    "machine_sandbox_recreate",
    "machine_sandbox_start",
    "machine_sandbox_end_session",
    "found_on_machine",
];
