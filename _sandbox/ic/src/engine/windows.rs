use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::fetch::{self, FetchOutcome};
use super::install_plan::{self, InstallFacts, InstallStep};
use super::paths;
use super::pins;
use super::record::EngineRecord;
use super::wsl;
use super::{Kind, Status, DISTRO};
use crate::docker::{self, EngineEnv};

const START_WAIT: Duration = Duration::from_secs(120);

pub fn status() -> Status {
    let installed = wsl::distro_installed(DISTRO);
    let record = EngineRecord::load();
    let version = record.as_ref().map(|record| record.version.clone());
    let running = record
        .as_ref()
        .filter(|record| record.is_ours())
        .is_some_and(engine_answers);
    Status {
        installed,
        running,
        version,
    }
}

pub fn download_bytes() -> u64 {
    let Some(dir) = paths::cache_dir() else {
        return pins::prefetch_total_bytes();
    };
    let mut need = 0u64;
    if !dir.join(pins::TARBALL_NAME).exists() {
        need += pins::DISTRO_TARBALL_BYTES;
    }
    if !dir.join("docker-cli.zip").exists() {
        need += pins::DOCKER_CLI_ZIP_BYTES;
    }
    need
}

pub fn fetch(progress: &mut dyn FnMut(u64, u64)) -> Result<(), String> {
    if !using_intentic_engine() {
        return Ok(());
    }
    if wsl::distro_installed(DISTRO) && EngineRecord::load().is_some() {
        return Ok(());
    }
    match fetch::fetch_all(progress)? {
        FetchOutcome::Complete | FetchOutcome::HeldByAnother => Ok(()),
    }
}

pub fn install(progress: &mut dyn FnMut(&str, Option<u64>)) -> Result<(), String> {
    progress("Fetching the engine…", Some(0));
    fetch(&mut |done, total| progress("Fetching the engine…", Some(pct(done, total))))?;
    let facts = gather_install_facts()?;
    let steps = install_plan::install_steps(&facts);
    let mut chosen_port = EngineRecord::load().map(|record| port_from_host(&record.host));
    for step in steps {
        match step {
            InstallStep::ImportDistro => {
                progress("Importing the WSL distro…", Some(15));
                import_distro()?;
            }
            InstallStep::GenerateTls => {
                progress("Generating TLS…", Some(40));
                if chosen_port.is_none() {
                    chosen_port = Some(pick_port()?);
                }
                generate_tls(chosen_port.expect("port chosen above"))?;
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
                let record = write_record(port)?;
                sync_docker_env(&record);
            }
            InstallStep::RegisterAutostart => register_autostart()?,
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

pub fn start_quiet() -> Result<(), String> {
    start_internal(true)
}

fn start_internal(quiet: bool) -> Result<(), String> {
    let record = EngineRecord::load().ok_or("the intentic engine is not installed on this PC.")?;
    if !record.is_ours() {
        return Err("this account's engine record is not intentic's.".to_string());
    }
    sync_docker_env(&record);
    if engine_answers(&record) {
        return Ok(());
    }
    if !quiet {
        println!("Starting the intentic engine…");
    }
    spawn_keeper(port_from_host(&record.host))?;
    wait_for_engine(&record, START_WAIT)
}

pub fn stop() -> Result<(), String> {
    let (code, _, stderr) = wsl::run_wsl(&["--terminate", DISTRO], Duration::from_secs(30))?;
    if code != 0 && !stderr.contains("not running") {
        return Err(stderr);
    }
    Ok(())
}

pub fn hold() -> Result<(), String> {
    stop()
}

pub fn update() -> Result<(), String> {
    fetch(&mut |_, _| {})?;
    stop()?;
    replace_linux_binaries()?;
    if let Some(mut record) = EngineRecord::load() {
        record.version = pins::ENGINE_VERSION.to_string();
        record.save()?;
        sync_docker_env(&record);
    }
    start()
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
    let _ = stop();
    let (code, _, stderr) = wsl::run_wsl(&["--unregister", DISTRO], Duration::from_secs(60))?;
    if code != 0 && !stderr.contains("not registered") {
        return Err(stderr);
    }
    EngineRecord::remove_file()?;
    docker::set_intentic_engine(None);
    unregister_autostart()?;
    Ok(())
}

pub fn adopt_env() {
    let Some(record) = EngineRecord::load() else {
        return;
    };
    if !record.is_ours() {
        return;
    }
    sync_docker_env(&record);
}

fn sync_docker_env(record: &EngineRecord) {
    docker::set_intentic_engine(Some(EngineEnv {
        host: record.host.clone(),
        cert_path: record.cert_path.clone(),
        bin: PathBuf::from(&record.bin),
    }));
}

fn using_intentic_engine() -> bool {
    use intentic_docker_host::desktop_app;
    let desktop = desktop_app::default_installs_here()
        .into_iter()
        .any(|path| Path::new(&path).exists());
    super::choose(desktop) == Kind::Intentic
}

fn pct(done: u64, total: u64) -> u64 {
    done.saturating_mul(100).checked_div(total).unwrap_or(0)
}

fn gather_install_facts() -> Result<InstallFacts, String> {
    Ok(InstallFacts {
        distro_registered: wsl::distro_installed(DISTRO),
        windows_client_tls_complete: windows_client_tls_complete(),
        distro_server_tls_present: distro_path_exists("/etc/intentic-engine/tls/server-cert.pem"),
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

fn distro_path_exists(path: &str) -> bool {
    wsl::run_wsl(
        &["-d", DISTRO, "-u", "root", "--exec", "test", "-f", path],
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

fn import_distro() -> Result<(), String> {
    if wsl::distro_installed(DISTRO) {
        return Ok(());
    }
    let store = paths::wsl_store().ok_or("LOCALAPPDATA is not set.")?;
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
        &["--import", DISTRO, &store, &tarball, "--version", "2"],
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

fn generate_tls(port: u16) -> Result<(), String> {
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
openssl x509 -req -days 3650 -sha256 -in client.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out client-cert.pem
"#;
    let (code, _, stderr) = wsl::run_wsl(
        &["-d", DISTRO, "-u", "root", "--exec", "sh", "-c", script],
        Duration::from_secs(180),
    )?;
    if code != 0 {
        return Err(format!("TLS generation failed: {stderr}"));
    }
    copy_from_distro("/etc/intentic-engine/tls/ca.pem", &tls_dir.join("ca.pem"))?;
    copy_from_distro(
        "/etc/intentic-engine/tls/client-cert.pem",
        &tls_dir.join("cert.pem"),
    )?;
    copy_from_distro("/etc/intentic-engine/tls/key.pem", &tls_dir.join("key.pem"))?;
    let _ = port;
    Ok(())
}

fn copy_from_distro(remote: &str, local: &Path) -> Result<(), String> {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["-d", DISTRO, "-u", "root", "--exec", "cat", remote]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let output = cmd
        .output()
        .map_err(|error| format!("wsl cat {remote}: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
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
    let zip_path = cache.join("docker-cli.zip");
    if !zip_path.exists() {
        return Err("docker CLI zip missing from the engine cache.".to_string());
    }
    let extract = cache.join("docker-cli-extract");
    let _ = std::fs::remove_dir_all(&extract);
    paths::ensure_dir(&extract)?;
    let zip = zip_path.to_string_lossy();
    let extract = extract.to_string_lossy();
    let (code, _, stderr) = docker::run_bounded(
        "powershell",
        &[
            "-NoProfile",
            "-Command",
            &format!("Expand-Archive -Force -Path '{zip}' -DestinationPath '{extract}'"),
        ],
        Duration::from_secs(120),
    )
    .map(|ran| (ran.code.unwrap_or(-1), ran.stdout, ran.stderr))
    .map_err(|fail| fail.0)?;
    if code != 0 {
        return Err(stderr);
    }
    let src = extract.to_string() + "\\docker\\docker.exe";
    std::fs::copy(&src, bin.join("docker.exe"))
        .map_err(|error| format!("could not install docker.exe: {error}"))?;
    Ok(())
}

fn write_record(port: u16) -> Result<EngineRecord, String> {
    let tls_dir = paths::tls_dir().ok_or("could not find this account's home folder.")?;
    let bin = paths::bin_dir().ok_or("could not find this account's home folder.")?;
    let record = EngineRecord {
        engine: Kind::Intentic.id().to_string(),
        host: format!("tcp://127.0.0.1:{port}"),
        cert_path: tls_dir.to_string_lossy().into_owned(),
        bin: bin.to_string_lossy().into_owned(),
        version: pins::ENGINE_VERSION.to_string(),
    };
    record.save()?;
    Ok(record)
}

fn port_from_host(host: &str) -> u16 {
    host.trim_start_matches("tcp://127.0.0.1:")
        .parse()
        .unwrap_or(2378)
}

fn spawn_keeper(port: u16) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    let argv = wsl::keeper_argv(port);
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    cmd.spawn()
        .map(|_| ())
        .map_err(|error| format!("could not start the engine keeper: {error}"))
}

fn wait_for_engine(record: &EngineRecord, limit: Duration) -> Result<(), String> {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if engine_answers(record) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    Err(format!(
        "the engine did not answer on {} within {} seconds — see the log inside the {DISTRO} distro (/var/log/intentic-engine.log).",
        record.host,
        limit.as_secs()
    ))
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

fn register_autostart() -> Result<(), String> {
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
    let (code, _, stderr) = docker::run_bounded(
        "reg",
        &[
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "IntenticEngine",
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

fn unregister_autostart() -> Result<(), String> {
    let _ = docker::run_bounded(
        "reg",
        &[
            "delete",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "IntenticEngine",
            "/f",
        ],
        Duration::from_secs(15),
    );
    Ok(())
}

fn replace_linux_binaries() -> Result<(), String> {
    let cache = paths::cache_dir().ok_or("could not find this account's home folder.")?;
    let tgz = cache.join("docker-linux.tgz");
    if !tgz.exists() {
        let agent = crate::fetch::agent();
        crate::fetch::resumable(
            &agent,
            pins::DOCKER_LINUX_URL,
            &[],
            &tgz,
            true,
            &mut |_, _| {},
        )?;
        fetch::verify_sha256_file(&tgz, pins::DOCKER_LINUX_SHA256)?;
    }
    let tgz_win = tgz.to_string_lossy();
    let script = format!(
        r#"set -eu
TGZ="$(wslpath -a '{tgz_win}')"
cd "$(dirname "$TGZ")"
tar -xzf "$(basename "$TGZ")"
for b in dockerd containerd containerd-shim-runc-v2 runc docker-init docker-proxy; do
  install -m 755 docker/$b /usr/local/bin/$b
done
"#
    );
    wsl::run_wsl(
        &["-d", DISTRO, "-u", "root", "--exec", "true"],
        Duration::from_secs(30),
    )?;
    let (code, _, stderr) = wsl::run_wsl(
        &["-d", DISTRO, "-u", "root", "--exec", "sh", "-c", &script],
        Duration::from_secs(120),
    )?;
    if code != 0 {
        return Err(stderr);
    }
    Ok(())
}
