use intentic_desktop_core::progress::Reporter;
use intentic_desktop_core::types::{
    CheckId, Engine, EnvironmentReport, FixOutcome, SandboxRecord, SandboxStatus, SetupMode,
    SetupRequest,
};
use intentic_desktop_core::{reconcile, sandbox};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::reporter::EventReporter;
use crate::setup_link::SetupArgs;
use crate::state::{AppState, Settings};

type CommandResult<T> = Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    pub version: String,
    pub os: String,
    pub app_url: String,
    pub platform_url: String,
}

#[tauri::command]
pub fn desktop_info(state: State<'_, AppState>) -> DesktopInfo {
    DesktopInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        os: std::env::consts::OS.into(),
        app_url: state.app_url(),
        platform_url: state.platform_url(),
    }
}

#[tauri::command]
pub fn pending_setup(state: State<'_, AppState>) -> Option<SetupArgs> {
    state.pending.lock().unwrap().clone()
}

#[tauri::command]
pub async fn environment_probe(app: AppHandle) -> CommandResult<EnvironmentReport> {
    let context = app.state::<AppState>().reconcile_context();
    let report = tauri::async_runtime::spawn_blocking(move || reconcile::probe(&context))
        .await
        .map_err(|error| error.to_string())?;
    *app.state::<AppState>().engine.lock().unwrap() = report.engine.clone();
    Ok(report)
}

#[tauri::command]
pub async fn environment_fix(app: AppHandle, check: CheckId) -> CommandResult<FixOutcome> {
    let context = app.state::<AppState>().reconcile_context();
    let reporter = EventReporter(app.clone());
    tauri::async_runtime::spawn_blocking(move || reconcile::fix(&context, check, &reporter))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

fn engine_of(app: &AppHandle) -> CommandResult<Engine> {
    app.state::<AppState>()
        .engine
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "the environment isn't ready yet — run the checks first".into())
}

#[tauri::command]
pub async fn setup_run(app: AppHandle, args: SetupArgs) -> CommandResult<SandboxRecord> {
    let engine = engine_of(&app)?;
    let state = app.state::<AppState>();
    *state.pending.lock().unwrap() = None;
    let request = SetupRequest {
        platform_url: args
            .platform_url
            .clone()
            .unwrap_or_else(|| state.platform_url()),
        code: args.code.clone(),
        mode: args.mode,
        name: args.name.clone(),
        cf_token: args.cf_token.clone(),
        sync_dir: args.sync_dir.clone(),
        image: std::env::var("INTENTIC_SANDBOX_IMAGE")
            .ok()
            .filter(|image| !image.is_empty()),
    };
    let data_dir = state.reconcile_context().data_dir;
    let reporter = EventReporter(app.clone());
    let record = tauri::async_runtime::spawn_blocking(move || -> Result<SandboxRecord, String> {
        let record = sandbox::run_setup(&engine, &request, &reporter).map_err(|error| {
            reporter.failed("setup", &error.to_string());
            error.to_string()
        })?;
        // Desktop sync is best-effort and tunnel-only: a failure warns, never blocks onboarding.
        if let (Some(sync_dir), Some(pair_token), SetupMode::Intentic | SetupMode::Own) =
            (&request.sync_dir, &record.sync_pair_token, request.mode)
        {
            reporter.started("sync", "Setting up desktop sync");
            match crate::sync_agent::enroll(&data_dir, &record.url, pair_token, sync_dir, &reporter)
            {
                Ok(()) => reporter.done("sync"),
                Err(error) => {
                    reporter.failed("sync", &format!("desktop sync didn't enroll: {error}"))
                }
            }
        }
        Ok(record)
    })
    .await
    .map_err(|error| error.to_string())??;
    app.state::<AppState>()
        .remember_name(&record.slug, record.name.as_deref());
    Ok(record)
}

#[tauri::command]
pub async fn sandbox_list(app: AppHandle) -> CommandResult<Vec<SandboxStatus>> {
    let engine = engine_of(&app)?;
    let mut statuses = tauri::async_runtime::spawn_blocking(move || sandbox::list(&engine))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    let state = app.state::<AppState>();
    for status in &mut statuses {
        status.name = state.name_of(&status.slug);
    }
    Ok(statuses)
}

#[tauri::command]
pub async fn sandbox_start(app: AppHandle, slug: String) -> CommandResult<()> {
    let engine = engine_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || sandbox::start(&engine, &slug))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn sandbox_stop(app: AppHandle, slug: String) -> CommandResult<()> {
    let engine = engine_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || sandbox::stop(&engine, &slug))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn sandbox_update(app: AppHandle, slug: String) -> CommandResult<()> {
    let engine = engine_of(&app)?;
    let reporter = EventReporter(app.clone());
    tauri::async_runtime::spawn_blocking(move || sandbox::update(&engine, &slug, &reporter))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn sandbox_remove(app: AppHandle, slug: String) -> CommandResult<()> {
    let engine = engine_of(&app)?;
    let removed_slug = slug.clone();
    tauri::async_runtime::spawn_blocking(move || sandbox::remove(&engine, &removed_slug))
        .await
        .map_err(|error| error.to_string())?;
    app.state::<AppState>().forget(&slug);
    Ok(())
}

#[tauri::command]
pub async fn sandbox_logs(app: AppHandle, slug: String, tail: u32) -> CommandResult<String> {
    let engine = engine_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        intentic_desktop_core::docker::logs_tail(&engine, &format!("intentic-sandbox-{slug}"), tail)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn workspace_open(app: AppHandle) {
    crate::windows::show_workspace(&app);
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, settings: Settings) {
    state.save_settings(settings);
}
