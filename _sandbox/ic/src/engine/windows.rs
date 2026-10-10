use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::fetch::{self, FetchOutcome};
use super::install_plan::{self, InstallFacts, InstallStep};
use super::paths;
use super::pins;
use super::record::{self, EngineRecord};
use super::wsl;
use super::{Kind, Status};
use crate::docker::{self, EngineEnv};

const START_WAIT: Duration = Duration::from_secs(120);

/// The keeper the distro runs (`dockerd` and what it needs first), written into the distro before every start, so a fix
/// to it reaches every installed engine with the next ic rather than with a new rootfs download.
const KEEPER: &str = include_str!("../../engine/rootfs/intentic-engine");
const KEEPER_PATH: &str = "/usr/local/bin/intentic-engine";
/// What a removal runs first: dockerd's bridges, routes and rules out of WSL's shared network namespace.
const TEARDOWN: &str = include_str!("../../engine/rootfs/teardown");
const TEARDOWN_PATH: &str = "/usr/local/bin/intentic-engine-teardown";

/// The distro this account's engine runs in: the record's, else the one a new install would import.
fn distro() -> String {
    EngineRecord::load()
        .map(|record| record.distro)
        .unwrap_or_else(super::install_distro)
}

pub fn status() -> Status {
    let record = EngineRecord::load();
    let distro = record
        .as_ref()
        .map(|record| record.distro.clone())
        .unwrap_or_else(super::install_distro);
    let installed = wsl::distro_installed(&distro);
    let version = record.as_ref().map(|record| record.version.clone());
    let running = record
        .as_ref()
        .filter(|record| record.is_ours())
        .is_some_and(engine_answers);
    let network = running.then(|| network_of(&distro)).flatten();
    let pipe = record
        .as_ref()
        .and_then(|record| record.pipe.clone())
        .filter(|pipe| {
            intentic_docker_host::engine_pipe::path_of(pipe)
                .is_some_and(|path| intentic_docker_host::engine_pipe::present(&path))
        });
    Status {
        installed,
        running,
        version,
        active: record.as_ref().is_some_and(EngineRecord::is_active),
        held: record::held(),
        distro,
        network,
        pipe,
    }
}

/// What the keeper wrote about the network its dockerd runs in (engine/rootfs/intentic-engine): `isolated` or `shared`.
fn network_of(distro: &str) -> Option<String> {
    let (code, said, _) = wsl::run_wsl(
        &[
            "-d",
            distro,
            "-u",
            "root",
            "--exec",
            "cat",
            "/run/intentic-engine/network",
        ],
        Duration::from_secs(15),
    )
    .ok()?;
    let mode = said.trim();
    (code == 0 && matches!(mode, "isolated" | "shared")).then(|| mode.to_string())
}

pub fn download_bytes() -> u64 {
    let Some(dir) = paths::cache_dir() else {
        return pins::prefetch_total_bytes();
    };
    let mut need = 0u64;
    if !dir.join(pins::TARBALL_NAME).exists() {
        need += pins::DISTRO_TARBALL_BYTES;
    }
    if !dir.join(pins::cli_zip_name()).exists() {
        need += pins::DOCKER_CLI_ZIP_BYTES;
    }
    need
}

pub fn fetch(progress: &mut dyn FnMut(u64, u64)) -> Result<(), String> {
    if !wanted_here() {
        return Ok(());
    }
    if wsl::distro_installed(&distro()) && EngineRecord::load().is_some() {
        return Ok(());
    }
    match fetch::fetch_all(progress)? {
        FetchOutcome::Complete => Ok(()),
        FetchOutcome::HeldByAnother => fetch::wait_for_other(progress),
    }
}

/// `activate`: whether this account's sandboxes run on the engine once it is in. A fresh PC's setup activates it; a
/// Docker Desktop PC installs it inactive, and `ic engine move` activates it once the sandboxes are across.
pub fn install(progress: &mut dyn FnMut(&str, Option<u64>), activate: bool) -> Result<(), String> {
    progress("Fetching the engine…", Some(0));
    match fetch::fetch_all(&mut |done, total| {
        progress("Fetching the engine…", Some(pct(done, total)))
    })? {
        FetchOutcome::Complete => {}
        FetchOutcome::HeldByAnother => fetch::wait_for_other(&mut |done, total| {
            progress("Fetching the engine…", Some(pct(done, total)))
        })?,
    }
    let existing = EngineRecord::load().filter(EngineRecord::is_ours);
    let distro = existing
        .as_ref()
        .map(|record| record.distro.clone())
        .unwrap_or_else(super::install_distro);
    let facts = gather_install_facts(&distro)?;
    let steps = install_plan::install_steps(&facts);
    let mut chosen_port = existing.as_ref().map(|record| port_from_host(&record.host));
    // An engine already active stays active: installing again repairs, it never takes a PC's sandboxes away from it.
    let activate = activate || existing.as_ref().is_some_and(|record| record.active);
    for step in steps {
        match step {
            InstallStep::ImportDistro => {
                progress("Importing the WSL distro…", Some(15));
                import_distro(&distro)?;
            }
            InstallStep::GenerateTls => {
                progress("Generating TLS…", Some(40));
                if chosen_port.is_none() {
                    chosen_port = Some(pick_port()?);
                }
                generate_tls(&distro)?;
            }
            InstallStep::InstallCli => {
                progress("Installing the docker CLI…", Some(70));
                install_cli()?;
            }
            InstallStep::WriteRecord => {
                let port = match chosen_port {
                    Some(port) => port,
                    None => pick_port()?,
                };
                let record = write_record(port, activate, &distro)?;
                if record.is_active() {
                    sync_docker_env(&record);
                }
            }
            InstallStep::RegisterAutostart => register_autostart(&distro)?,
            InstallStep::StartEngine => {
                progress("Starting the engine…", Some(90));
                start()?;
                progress("Engine is running.", Some(100));
            }
        }
    }
    Ok(())
}

pub fn start() -> Result<(), String> {
    start_internal(false)
}

/// The sign-in start (the Run key) and every background one: an engine nobody's sandboxes run on stays down rather than
/// holding memory, and one stopped on purpose stays stopped.
pub fn start_quiet() -> Result<(), String> {
    let Some(record) = EngineRecord::load() else {
        return Ok(());
    };
    // Wanted when this account's sandboxes run on it, or when a WSL distro uses it as its Docker
    // (engine/wsl_integration.rs), whichever engine the Windows side's sandboxes are on.
    let wanted = record.is_active() || (record.is_ours() && !record.wsl.is_empty());
    if !wanted || record::held() {
        return Ok(());
    }
    start_internal(true)
}

fn start_internal(quiet: bool) -> Result<(), String> {
    let mut record =
        EngineRecord::load().ok_or("the intentic engine is not installed on this PC.")?;
    if !record.is_ours() {
        return Err("this account's engine record is not intentic's.".to_string());
    }
    // A start asked for is the end of any hold.
    record::release();
    if engine_answers(&record) {
        keep_relay(&mut record, quiet);
        super::wsl_integration::apply_all(&record, quiet);
        return Ok(());
    }
    if !quiet {
        println!("Starting the intentic engine…");
    }
    // An engine from an older ic is brought up to this one's docker as it starts: it is down already, so nothing that
    // runs on it is interrupted for it. One that cannot be (offline) starts as it is, and is tried again next time.
    if record.version != pins::ENGINE_VERSION {
        if !quiet {
            println!(
                "Updating the engine from {} to {} (docker {})…",
                record.version,
                pins::ENGINE_VERSION,
                pins::DOCKER_CLI_VERSION
            );
        }
        let _ = terminate();
        if let Err(problem) = upgrade_in_place(&mut record) {
            println!("Note: the engine was not updated ({problem}); starting the docker it has.");
        }
    }
    if let Err(problem) = write_into_distro(&record.distro, KEEPER_PATH, KEEPER) {
        // The rootfs carries a keeper of its own: an older one, but one that runs.
        println!(
            "Note: could not refresh the engine's keeper ({problem}); starting the one it has."
        );
    }
    let mut keeper = spawn_keeper(&record.distro, port_from_host(&record.host))?;
    wait_for_engine(&record, START_WAIT, &mut keeper)?;
    keep_relay(&mut record, quiet);
    super::wsl_integration::apply_all(&record, quiet);
    Ok(())
}

/// The engine's named pipe (engine/relay.rs) served by this ic's relay, and the record naming it; then every `docker`
/// of this run pointed the way the record now says. A relay that will not run costs speed, never the start: clients
/// reach the TLS endpoint without it.
fn keep_relay(record: &mut EngineRecord, quiet: bool) {
    if let Err(problem) = super::relay::ensure(record) {
        if !quiet {
            println!("Note: the engine's named pipe is not up ({problem}); docker reaches it over TCP meanwhile.");
        }
    }
    if record.is_active() {
        sync_docker_env(record);
    }
}

/// The engine down, and held down: nothing that keeps it running (the desktop app, the machine agent's repairs, the
/// sign-in start) brings it back until `ic engine start`.
pub fn stop() -> Result<(), String> {
    record::hold_as("stopped by `ic engine stop`")?;
    super::relay::stop();
    terminate()
}

pub fn hold() -> Result<(), String> {
    record::hold_as("held by `ic engine hold`")?;
    super::relay::stop();
    terminate()
}

/// `ic engine relay`: serve the engine on its named pipe until a newer relay or a stop takes over (engine/relay.rs).
pub fn relay() -> Result<(), String> {
    super::relay::run()
}

/// The distro stopped, with no hold: what a restart does before it starts the engine again.
pub fn terminate() -> Result<(), String> {
    let distro = distro();
    let (code, _, stderr) = wsl::run_wsl(&["--terminate", &distro], Duration::from_secs(30))?;
    if code != 0 && !stderr.contains("not running") && !stderr.contains("not found") {
        return Err(stderr);
    }
    Ok(())
}

/// Stop, then start: for an engine that is up and does not answer.
pub fn restart() -> Result<(), String> {
    terminate()?;
    std::thread::sleep(Duration::from_secs(2));
    start()
}

pub fn update() -> Result<(), String> {
    let mut record =
        EngineRecord::load().ok_or("the intentic engine is not installed on this PC.")?;
    let was_held = record::held();
    terminate()?;
    upgrade_in_place(&mut record)?;
    if record.is_active() {
        sync_docker_env(&record);
    }
    if was_held {
        return Ok(());
    }
    start()
}

/// The pinned docker binaries into the stopped distro, the pinned CLI beside them, and the record's version: an engine
/// imported from an older rootfs brought up to this ic's, its images, volumes and containers kept (they live in the
/// distro's `/var/lib/docker`). The keeper needs nothing here: every start writes the current one.
fn upgrade_in_place(record: &mut EngineRecord) -> Result<(), String> {
    replace_linux_binaries(&record.distro)?;
    if !cli_version_matches() {
        fetch::ensure_cli_zip()?;
        install_cli()?;
    }
    record.version = pins::ENGINE_VERSION.to_string();
    record.save()
}

/// Switch this account's sandboxes onto our engine (`on`) or off it, which every `docker` spawned from now on obeys.
pub fn set_active(on: bool) -> Result<(), String> {
    let mut record = EngineRecord::load()
        .filter(EngineRecord::is_ours)
        .ok_or("the intentic engine is not installed on this PC.")?;
    record.active = on;
    record.save()?;
    if on {
        sync_docker_env(&record);
    } else {
        docker::set_intentic_engine(None);
    }
    Ok(())
}

/// How to reach our engine, active or not: the move reads both engines at once.
pub fn reach() -> Option<EngineEnv> {
    EngineRecord::load()
        .filter(EngineRecord::is_ours)
        .map(|record| env_of(&record))
}

pub fn remove(yes: bool) -> Result<(), String> {
    let terminal = IsTerminal::is_terminal(&std::io::stdout());
    if !yes {
        if terminal {
            if !crate::tty::confirm(
                "Remove the intentic engine? Every sandbox's Docker data in this distro is deleted.",
                false,
            ) {
                return Err("cancelled.".to_string());
            }
        } else {
            return Err(
                "refusing to remove the intentic engine without --yes (there is no terminal to ask on)."
                    .to_string(),
            );
        }
    }
    let distro = distro();
    // What dockerd put into WSL's shared network goes before the distro does: nothing else would take it out.
    if write_into_distro(&distro, TEARDOWN_PATH, TEARDOWN).is_ok() {
        let _ = wsl::run_wsl(
            &["-d", &distro, "-u", "root", "--exec", TEARDOWN_PATH],
            Duration::from_secs(60),
        );
    }
    let _ = terminate();
    let (code, _, stderr) = wsl::run_wsl(&["--unregister", &distro], Duration::from_secs(60))?;
    if code != 0 && !stderr.contains("not registered") && !stderr.contains("not found") {
        return Err(stderr);
    }
    EngineRecord::remove_file()?;
    record::release();
    super::relay::remove_files();
    // The client half of the TLS pair and the CLI go with the engine they reach; the download cache stays, so a
    // reinstall does not fetch the same 90 MB again.
    for dir in [paths::tls_dir(), paths::bin_dir()].into_iter().flatten() {
        let _ = std::fs::remove_dir_all(dir);
    }
    docker::set_intentic_engine(None);
    unregister_autostart(&distro)?;
    Ok(())
}

pub fn adopt_env() {
    let Some(record) = EngineRecord::load() else {
        return;
    };
    if record.is_active() {
        sync_docker_env(&record);
        return;
    }
    // Started by an app that read the record while it was active (before a move back to Docker Desktop): its engine
    // variables would send every `docker` of this run to an engine no sandbox runs on.
    let inherited = std::env::var("DOCKER_HOST").ok();
    if record.is_ours()
        && (inherited.as_deref() == Some(record.host.as_str())
            || (inherited.is_some() && inherited == record.pipe))
    {
        docker::forget_engine_vars();
    }
}

fn env_of(record: &EngineRecord) -> EngineEnv {
    EngineEnv {
        host: record.host.clone(),
        cert_path: record.cert_path.clone(),
        bin: PathBuf::from(&record.bin),
        pipe: record.pipe.clone(),
    }
}

fn sync_docker_env(record: &EngineRecord) {
    docker::set_intentic_engine(Some(env_of(record)));
}

/// Whether this account's setup wants our engine at all: it runs on it, or a fresh setup would choose it.
fn wanted_here() -> bool {
    if EngineRecord::load().is_some_and(|record| record.is_active()) {
        return true;
    }
    use intentic_docker_host::desktop_app;
    let desktop = desktop_app::default_installs_here()
        .into_iter()
        .any(|path| Path::new(&path).exists());
    super::choose(desktop) == Kind::Intentic
}

fn pct(done: u64, total: u64) -> u64 {
    done.saturating_mul(100).checked_div(total).unwrap_or(0)
}

fn gather_install_facts(distro: &str) -> Result<InstallFacts, String> {
    Ok(InstallFacts {
        distro_registered: wsl::distro_installed(distro),
        windows_client_tls_complete: windows_client_tls_complete(),
        distro_server_tls_present: distro_path_exists(
            distro,
            "/etc/intentic-engine/tls/server-cert.pem",
        ),
        cli_present: paths::bin_dir()
            .map(|dir| dir.join("docker.exe").exists())
            .unwrap_or(false),
        cli_version_matches: cli_version_matches(),
    })
}

fn windows_client_tls_complete() -> bool {
    let Some(tls) = paths::tls_dir() else {
        return false;
    };
    ["ca.pem", "cert.pem", "key.pem"]
        .iter()
        .all(|name| tls.join(name).is_file())
}

fn distro_path_exists(distro: &str, path: &str) -> bool {
    wsl::run_wsl(
        &["-d", distro, "-u", "root", "--exec", "test", "-f", path],
        Duration::from_secs(15),
    )
    .map(|(code, _, _)| code == 0)
    .unwrap_or(false)
}

fn cli_version_matches() -> bool {
    let Some(bin) = paths::bin_dir() else {
        return false;
    };
    let docker = bin.join("docker.exe");
    if !docker.is_file() {
        return false;
    }
    let Ok(ran) = docker::run_bounded(
        &docker.to_string_lossy(),
        &["--version"],
        Duration::from_secs(10),
    ) else {
        return false;
    };
    ran.code == Some(0) && ran.stdout.contains(pins::DOCKER_CLI_VERSION)
}

fn import_distro(distro: &str) -> Result<(), String> {
    if wsl::distro_installed(distro) {
        return Ok(());
    }
    let store = paths::wsl_store_for(distro).ok_or("LOCALAPPDATA is not set.")?;
    paths::ensure_dir(&store)?;
    let cache = paths::cache_dir().ok_or("could not find this account's home folder.")?;
    let tarball = cache.join(pins::TARBALL_NAME);
    if !tarball.exists() {
        return Err(format!(
            "engine tarball missing at {}; run ic engine fetch first.",
            tarball.display()
        ));
    }
    let tarball = tarball.to_string_lossy();
    let store = store.to_string_lossy();
    let (code, _, stderr) = wsl::run_wsl(
        &["--import", distro, &store, &tarball, "--version", "2"],
        Duration::from_secs(600),
    )?;
    if code != 0 {
        return Err(stderr);
    }
    Ok(())
}

fn pick_port() -> Result<u16, String> {
    for port in [2378u16, 2379, 2380, 2381, 2382] {
        if port_free(port) {
            return Ok(port);
        }
    }
    Err("could not find a free TCP port on 127.0.0.1 for the engine.".to_string())
}

fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn generate_tls(distro: &str) -> Result<(), String> {
    let tls_dir = paths::tls_dir().ok_or("could not find this account's home folder.")?;
    paths::ensure_dir(&tls_dir)?;
    let script = r#"set -eu
mkdir -p /etc/intentic-engine/tls
cd /etc/intentic-engine/tls
openssl genrsa -out ca-key.pem 4096
openssl req -new -x509 -days 3650 -key ca-key.pem -sha256 -subj "/CN=intentic-engine-ca" -out ca.pem
openssl genrsa -out server-key.pem 4096
openssl req -new -key server-key.pem -subj "/CN=intentic-engine" -out server.csr
echo "subjectAltName=IP:127.0.0.1" > extfile.cnf
openssl x509 -req -days 3650 -sha256 -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out server-cert.pem -extfile extfile.cnf
openssl genrsa -out key.pem 4096
openssl req -new -key key.pem -subj "/CN=intentic-client" -out client.csr
echo "extendedKeyUsage=clientAuth" > client.cnf
openssl x509 -req -days 3650 -sha256 -in client.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out client-cert.pem -extfile client.cnf
"#;
    let (code, _, stderr) = wsl::run_wsl(
        &["-d", distro, "-u", "root", "--exec", "sh", "-c", script],
        Duration::from_secs(180),
    )?;
    if code != 0 {
        return Err(format!("TLS generation failed: {stderr}"));
    }
    copy_from_distro(
        distro,
        "/etc/intentic-engine/tls/ca.pem",
        &tls_dir.join("ca.pem"),
    )?;
    copy_from_distro(
        distro,
        "/etc/intentic-engine/tls/client-cert.pem",
        &tls_dir.join("cert.pem"),
    )?;
    copy_from_distro(
        distro,
        "/etc/intentic-engine/tls/key.pem",
        &tls_dir.join("key.pem"),
    )?;
    Ok(())
}

/// `text` into `path` inside the distro, as root, executable: written beside it and moved over it, so a keeper that is
/// starting never reads half a file. Bounded, since a wedged WSL answers nothing at all.
pub(super) fn write_into_distro(distro: &str, path: &str, text: &str) -> Result<(), String> {
    let script =
        format!("cat > '{path}.new' && chmod 755 '{path}.new' && mv -f '{path}.new' '{path}'");
    let mut child = Command::new("wsl.exe")
        .args(["-d", distro, "-u", "root", "--exec", "sh", "-c", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("wsl: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| format!("writing {path}: {error}"))?;
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                let mut said = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    let _ = std::io::Read::read_to_string(&mut stderr, &mut said);
                }
                return Err(said.trim().to_string());
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return Err(format!("writing {path} into {distro} did not finish"));
            }
        }
    }
}

/// `remote` out of the distro into `local`, tried twice: on rog (2026-10-10) the first `cat` after a fresh import's
/// TLS step failed once with nothing on stderr, and the same install run again copied all three files.
fn copy_from_distro(distro: &str, remote: &str, local: &Path) -> Result<(), String> {
    copy_from_distro_once(distro, remote, local).or_else(|_| {
        std::thread::sleep(Duration::from_secs(2));
        copy_from_distro_once(distro, remote, local)
    })
}

fn copy_from_distro_once(distro: &str, remote: &str, local: &Path) -> Result<(), String> {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["-d", distro, "-u", "root", "--exec", "cat", remote]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let output = cmd
        .output()
        .map_err(|error| format!("wsl cat {remote}: {error}"))?;
    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr).replace('\0', "");
        let said = said.trim();
        return Err(if said.is_empty() {
            format!(
                "copying {remote} out of {distro} failed (wsl exited {}).",
                output.status.code().unwrap_or(-1)
            )
        } else {
            said.to_string()
        });
    }
    let mut file =
        std::fs::File::create(local).map_err(|error| format!("{}: {error}", local.display()))?;
    file.write_all(&output.stdout)
        .map_err(|error| format!("{}: {error}", local.display()))?;
    Ok(())
}

fn install_cli() -> Result<(), String> {
    let bin = paths::bin_dir().ok_or("could not find this account's home folder.")?;
    paths::ensure_dir(&bin)?;
    let cache = paths::cache_dir().ok_or("could not find this account's home folder.")?;
    let zip_path = cache.join(pins::cli_zip_name());
    if !zip_path.exists() {
        return Err("docker CLI zip missing from the engine cache.".to_string());
    }
    let extract = cache.join("docker-cli-extract");
    let _ = std::fs::remove_dir_all(&extract);
    paths::ensure_dir(&extract)?;
    let zip_ps = zip_path.to_string_lossy().replace('\'', "''");
    let extract_ps = extract.to_string_lossy().replace('\'', "''");
    // Archive's script module may not load under the caller's PowerShell policy or module path. The framework's
    // ZIP reader needs only its assembly, and the fresh extraction directory needs no overwrite mode.
    let script = format!(
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; \
         [System.IO.Compression.ZipFile]::ExtractToDirectory('{zip_ps}', '{extract_ps}')"
    );
    let (code, _, stderr) = docker::run_bounded(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", &script],
        Duration::from_secs(120),
    )
    .map(|ran| (ran.code.unwrap_or(-1), ran.stdout, ran.stderr))
    .map_err(|fail| fail.0)?;
    if code != 0 {
        return Err(stderr);
    }
    let src = extract.join("docker").join("docker.exe");
    std::fs::copy(&src, bin.join("docker.exe"))
        .map_err(|error| format!("could not install docker.exe: {error}"))?;
    Ok(())
}

fn write_record(port: u16, active: bool, distro: &str) -> Result<EngineRecord, String> {
    let tls_dir = paths::tls_dir().ok_or("could not find this account's home folder.")?;
    let bin = paths::bin_dir().ok_or("could not find this account's home folder.")?;
    let record = EngineRecord {
        engine: Kind::Intentic.id().to_string(),
        host: format!("tcp://127.0.0.1:{port}"),
        cert_path: tls_dir.to_string_lossy().into_owned(),
        bin: bin.to_string_lossy().into_owned(),
        version: pins::ENGINE_VERSION.to_string(),
        active,
        distro: distro.to_string(),
        pipe: None,
        wsl: existing_wsl(),
    };
    record.save()?;
    Ok(record)
}

pub(super) fn port_from_host(host: &str) -> u16 {
    host.trim_start_matches("tcp://127.0.0.1:")
        .parse()
        .unwrap_or(2378)
}

/// ic's own stdin, stdout and stderr, made non-inheritable before the keeper starts. A Windows child inherits every
/// inheritable handle of its parent whatever its own stdio is set to, so the keeper, which outlives this run by days,
/// kept a copy of ic's stdout: whoever read ic's output to its end (a PowerShell pipeline, a CI step) waited forever
/// (omen, 2026-10-09). Every later child still gets these: std duplicates an inherited handle for each spawn.
pub(super) fn keep_own_handles() {
    extern "system" {
        fn GetStdHandle(which: u32) -> *mut std::ffi::c_void;
        fn SetHandleInformation(handle: *mut std::ffi::c_void, mask: u32, flags: u32) -> i32;
    }
    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;
    // STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE: -10, -11, -12 as DWORDs.
    for which in [0xFFFF_FFF6u32, 0xFFFF_FFF5, 0xFFFF_FFF4] {
        // SAFETY: GetStdHandle takes a constant and answers a handle, null, or INVALID_HANDLE_VALUE (-1); only a real
        // handle is handed to SetHandleInformation, which changes nothing but its inherit flag.
        unsafe {
            let handle = GetStdHandle(which);
            if !handle.is_null() && handle as isize != -1 {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

fn spawn_keeper(distro: &str, port: u16) -> Result<std::process::Child, String> {
    use std::os::windows::process::CommandExt;
    keep_own_handles();
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    let argv = wsl::keeper_argv(distro, port);
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    cmd.spawn()
        .map_err(|error| format!("could not start the engine keeper: {error}"))
}

/// The keeper exited on purpose: another Docker engine in WSL owns docker0 (engine/rootfs/intentic-engine).
const KEEPER_REFUSED: i32 = 3;
/// The keeper exited on purpose: one already runs in the distro (two starts at once, or a start while the first keeper
/// still brings dockerd up), and the engine is on its way rather than broken.
const KEEPER_ALREADY_RUNNING: i32 = 4;

fn wait_for_engine(
    record: &EngineRecord,
    limit: Duration,
    keeper: &mut std::process::Child,
) -> Result<(), String> {
    let deadline = Instant::now() + limit;
    let mut another_keeper = false;
    while Instant::now() < deadline {
        if engine_answers(record) {
            return Ok(());
        }
        // A keeper that has ended will not bring the engine up however long this waits: say why now. One that ended
        // because another keeper runs leaves the wait to that one.
        if !another_keeper {
            if let Ok(Some(status)) = keeper.try_wait() {
                if engine_answers(record) {
                    return Ok(());
                }
                if status.code() != Some(KEEPER_ALREADY_RUNNING) {
                    return Err(keeper_ended(record, status.code()));
                }
                another_keeper = true;
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    Err(not_answering(record, limit, another_keeper))
}

/// Pure: the sentence for an engine that did not answer within `limit`, `another_keeper` when the keeper this start ran
/// found one already running.
fn not_answering(record: &EngineRecord, limit: Duration, another_keeper: bool) -> String {
    if another_keeper {
        return format!(
            "the engine's keeper is already running in the {} distro, but the engine did not answer on {} within {} seconds — `ic engine restart` starts it over.",
            record.distro,
            record.host,
            limit.as_secs(),
        );
    }
    format!(
        "the engine did not answer on {} within {} seconds — see the log inside the {} distro (/var/log/intentic-engine.log).",
        record.host,
        limit.as_secs(),
        record.distro,
    )
}

/// Why the keeper ended before the engine answered, in a person's words: the clash it refused, or the end of its log.
fn keeper_ended(record: &EngineRecord, code: Option<i32>) -> String {
    let said = wsl::run_wsl(
        &[
            "-d",
            &record.distro,
            "-u",
            "root",
            "--exec",
            "sh",
            "-c",
            "cat /var/run/intentic-engine.refused 2>/dev/null; echo; tail -n 3 /var/log/intentic-engine.log 2>/dev/null",
        ],
        Duration::from_secs(20),
    )
    .map(|(_, out, _)| out)
    .unwrap_or_default();
    keeper_sentence(code, &said)
}

/// Pure: the sentence for a keeper that ended with `code`, from what the distro said (the refusal's owner on its first
/// line when there was one, then the log's last lines).
pub(super) fn keeper_sentence(code: Option<i32>, said: &str) -> String {
    let mut lines = said.lines();
    let owner = lines.next().unwrap_or_default().trim();
    if code == Some(KEEPER_REFUSED) {
        let at = if owner.is_empty() {
            String::new()
        } else {
            format!(" (its bridge, docker0, is {owner})")
        };
        return format!(
            "another Docker engine is running inside WSL{at}. Every WSL distro shares one network, and two engines there undo each other's rules, so Intentic's engine did not start beside it. Stop that engine (in its distro: sudo systemctl disable --now docker), or keep your sandboxes on it, then try again."
        );
    }
    let tail: Vec<&str> = lines
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    format!(
        "the engine stopped as it started ({}){}",
        code.map(|code| format!("exit {code}"))
            .unwrap_or_else(|| "no exit code".to_string()),
        if tail.is_empty() {
            String::new()
        } else {
            format!(": {}", tail.join(" / "))
        }
    )
}

fn engine_answers(record: &EngineRecord) -> bool {
    docker::engine_with_env(
        &record.host,
        &record.cert_path,
        Path::new(&record.bin),
        Duration::from_secs(5),
    )
    .up()
}

/// The Run key's value: one per distro, so a test engine beside the real one never replaces its sign-in start.
fn autostart_value(distro: &str) -> String {
    if distro == super::DISTRO {
        "IntenticEngine".to_string()
    } else {
        format!("IntenticEngine-{distro}")
    }
}

fn register_autostart(distro: &str) -> Result<(), String> {
    if std::env::var("IC_ENGINE_AUTOSTART").as_deref() == Ok("0") {
        return Ok(());
    }
    let ic = paths::ic_exe().filter(|path| path.is_file());
    let ic = ic.or_else(|| {
        std::env::current_exe()
            .ok()
            .filter(|path| path.file_name().is_some_and(|name| name == "ic.exe"))
    });
    let Some(ic) = ic else {
        println!(
            "Note: could not register intentic engine autostart — neither {} nor the running ic.exe exists.",
            paths::ic_exe()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "~/.intentic/ic/bin/ic.exe".to_string())
        );
        return Ok(());
    };
    let command = format!("\"{}\" engine start --quiet", ic.display());
    let value = autostart_value(distro);
    let (code, _, stderr) = docker::run_bounded(
        "reg",
        &[
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            &value,
            "/t",
            "REG_SZ",
            "/d",
            &command,
            "/f",
        ],
        Duration::from_secs(15),
    )
    .map(|ran| (ran.code.unwrap_or(-1), ran.stdout, ran.stderr))
    .map_err(|fail| fail.0)?;
    if code != 0 {
        return Err(stderr);
    }
    println!(
        "Registered intentic engine autostart at sign-in: {}",
        ic.display()
    );
    Ok(())
}

fn unregister_autostart(distro: &str) -> Result<(), String> {
    let value = autostart_value(distro);
    let _ = docker::run_bounded(
        "reg",
        &[
            "delete",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            &value,
            "/f",
        ],
        Duration::from_secs(15),
    );
    Ok(())
}

/// The WSL distros a record about to be rewritten serves (an install over an existing engine keeps them).
fn existing_wsl() -> Vec<String> {
    EngineRecord::load()
        .map(|record| record.wsl)
        .unwrap_or_default()
}

fn replace_linux_binaries(distro: &str) -> Result<(), String> {
    let tgz = fetch::ensure_pinned(
        pins::DOCKER_LINUX_URL,
        &pins::linux_tgz_name(),
        pins::DOCKER_LINUX_SHA256,
    )?;
    let tgz_win = tgz.to_string_lossy();
    let script = format!(
        r#"set -eu
TGZ="$(wslpath -a '{tgz_win}')"
WORK=/tmp/intentic-engine-update
rm -rf "$WORK" && mkdir -p "$WORK"
tar -xzf "$TGZ" -C "$WORK"
for b in dockerd containerd containerd-shim-runc-v2 runc docker-init docker-proxy; do
  install -m 755 "$WORK/docker/$b" "/usr/local/bin/$b"
done
rm -rf "$WORK"
"#
    );
    wsl::run_wsl(
        &["-d", distro, "-u", "root", "--exec", "true"],
        Duration::from_secs(30),
    )?;
    let (code, _, stderr) = wsl::run_wsl(
        &["-d", distro, "-u", "root", "--exec", "sh", "-c", &script],
        Duration::from_secs(120),
    )?;
    if code != 0 {
        return Err(stderr);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_engine_another_keeper_brings_up_is_named_as_such_when_it_never_answers() {
        let record = EngineRecord {
            engine: "intentic".into(),
            host: "tcp://127.0.0.1:2378".into(),
            cert_path: String::new(),
            bin: String::new(),
            version: "1.1.0".into(),
            active: true,
            distro: "intentic-engine".into(),
            pipe: None,
            wsl: Vec::new(),
        };
        let waiting = not_answering(&record, Duration::from_secs(120), true);
        assert!(waiting.contains("keeper is already running in the intentic-engine distro"));
        assert!(waiting.contains("ic engine restart"));
        let silent = not_answering(&record, Duration::from_secs(120), false);
        assert!(silent.contains("/var/log/intentic-engine.log"));
    }

    #[test]
    fn a_keeper_that_refused_names_the_engine_it_found_and_what_to_do() {
        let sentence = keeper_sentence(Some(3), "172.17.0.1/16\nlog line\n");
        assert!(sentence.contains("another Docker engine is running inside WSL"));
        assert!(sentence.contains("172.17.0.1/16"));
        assert!(sentence.contains("systemctl disable --now docker"));
        let crashed = keeper_sentence(Some(1), "\nfailed to start daemon: x\n");
        assert!(crashed.contains("exit 1"));
        assert!(crashed.contains("failed to start daemon: x"));
    }

    #[test]
    fn the_default_distro_keeps_its_old_run_key_and_any_other_gets_its_own() {
        assert_eq!(autostart_value(super::super::DISTRO), "IntenticEngine");
        assert_eq!(
            autostart_value("intentic-engine-ci"),
            "IntenticEngine-intentic-engine-ci"
        );
    }
}
