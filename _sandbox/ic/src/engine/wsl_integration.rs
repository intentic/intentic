//! THIS ENGINE AS A WSL DISTRO'S DOCKER (2026-10-10): `ic engine wsl enable|disable <distro>`.
//!
//! Docker Desktop's WSL integration gives a distro three things, and a PC that drops Docker Desktop loses all three: a
//! `/var/run/docker.sock`, bind mounts of the distro's own paths (`docker run -v ~/project:/x`, which Docker Desktop
//! rewrites to a share of its own), and the `docker` CLI with its `compose` and `buildx` plugins (links into
//! `/mnt/wsl/docker-desktop`). A developer who runs a sandbox from a checkout inside WSL needs every one of them: the dev
//! sandbox bind-mounts its build output from the checkout, and the local platform's database is a `docker compose`
//! service. This gives the distro the same from our engine:
//!
//! - the keeper serves the API on a socket in `/mnt/wsl/<engine>/` (one tmpfs every distro mounts, shared), which the
//!   distro links as its `/run/docker.sock`, in its own docker group;
//! - the distro's `/home` is bind-mounted under `/mnt/wsl/<engine>/distros/<distro>/home`, and the keeper links each
//!   `/home/<user>` in the engine's distro to it, so a bind mount resolves there by the very path it was named with;
//! - the static `docker` from the engine's pinned bundle, and pinned `compose` and `buildx`, are installed to
//!   `/usr/local/lib/intentic/docker` and linked onto PATH and into `/usr/local/lib/docker/cli-plugins`, except where
//!   the distro's own packages provide them.
//!
//! The distro's part (engine/rootfs/integrate) runs at every start of the distro from a systemd unit, and again from
//! `ic engine start` once the engine is up, so either may start first.
//!
//! Docker Desktop may go on serving the same distro: its integration's proxy holds `/run/docker.sock` there while it
//! runs, and so does a dockerd of the distro's own. Neither is taken over. The distro's default user gets a docker
//! context instead, `intentic-engine`, naming our socket, and made current: every `docker` and `docker compose` of
//! that user's (the dev loop's scripts, the machine agent) reaches our engine, and `docker --context default` the
//! other one, so a PC keeps Docker Desktop for whatever still lives there. What a context does not reach is a program
//! that opens `/var/run/docker.sock` itself rather than asking the CLI.

use std::time::Duration;

use super::pins;
use super::record::EngineRecord;
use super::wsl;
use super::Kind;

const INTEGRATE: &str = include_str!("../../engine/rootfs/integrate");
const INTEGRATE_PATH: &str = "/usr/local/lib/intentic/engine-integration";
const UNIT_PATH: &str = "/etc/systemd/system/intentic-engine-integration.service";
const TOOLS_DIR: &str = "/usr/local/lib/intentic/docker";
/// The docker context a distro another engine also serves reaches ours by.
const CONTEXT: &str = "intentic-engine";

fn record() -> Result<EngineRecord, String> {
    EngineRecord::load()
        .filter(|record| record.engine == Kind::Intentic.id())
        .ok_or_else(|| {
            "Intentic's engine is not installed on this PC: ic engine install".to_string()
        })
}

fn as_root(distro: &str, script: &str, limit: Duration) -> Result<String, String> {
    let (code, stdout, stderr) = wsl::run_wsl(
        &["-d", distro, "-u", "root", "--exec", "sh", "-c", script],
        limit,
    )?;
    if code != 0 {
        let said = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        return Err(format!("in {distro}: {}", said.trim()));
    }
    Ok(stdout)
}

/// The distro's systemd unit: the integration at every start of the distro, before anything that wants Docker.
fn unit(engine: &str, distro: &str) -> String {
    format!(
        "[Unit]\n\
         Description=Docker from Intentic's engine ({engine}), as `ic engine wsl enable` set it up\n\
         DefaultDependencies=no\n\
         After=local-fs.target\n\
         \n\
         [Service]\n\
         Type=oneshot\n\
         RemainAfterExit=yes\n\
         ExecStart={INTEGRATE_PATH} {engine} {distro}\n\
         \n\
         [Install]\n\
         WantedBy=multi-user.target\n"
    )
}

/// The CLI and its plugins from the cache into the distro, linked where nothing of the distro's own packages is.
/// Pure: the script, given where the three files are (Windows paths the distro reads through `wslpath`).
pub(super) fn tools_script(tgz: &str, compose: &str, buildx: &str) -> String {
    let quote = |path: &str| path.replace('\'', "'\\''");
    format!(
        r#"set -eu
DIR={TOOLS_DIR}
mkdir -p "$DIR" /usr/local/bin /usr/local/lib/docker/cli-plugins
WORK="$(mktemp -d)"
tar -xzf "$(wslpath -a '{tgz}')" -C "$WORK" docker/docker
install -m 755 "$WORK/docker/docker" "$DIR/docker"
install -m 755 "$(wslpath -a '{compose}')" "$DIR/docker-compose"
install -m 755 "$(wslpath -a '{buildx}')" "$DIR/docker-buildx"
rm -rf "$WORK"
# A link this integration or Docker Desktop's made (into /mnt/wsl) is ours to point; a file the distro's packages
# installed is not.
managed() {{
  [ ! -e "$1" ] && [ ! -L "$1" ] && return 0
  case "$(readlink "$1" 2>/dev/null)" in /mnt/wsl/* | "$DIR"/*) return 0 ;; esac
  return 1
}}
# A docker the distro's packages installed stays the one on PATH; Windows' own on the appended PATH (Docker Desktop's
# shim, which only says to turn its integration on) does not count.
own=""
for candidate in /usr/local/bin/docker /usr/local/sbin/docker /usr/sbin/docker /usr/bin/docker /sbin/docker /bin/docker; do
  if [ -e "$candidate" ] && ! managed "$candidate"; then own="$candidate"; break; fi
done
if [ -z "$own" ]; then
  ln -sfn "$DIR/docker" /usr/local/bin/docker
fi
for plugin in docker-compose docker-buildx; do
  link=/usr/local/lib/docker/cli-plugins/$plugin
  if managed "$link"; then ln -sfn "$DIR/$plugin" "$link"; fi
done
"$DIR/docker" --version
"#,
        tgz = quote(tgz),
        compose = quote(compose),
        buildx = quote(buildx),
    )
}

/// Make the `intentic-engine` context (our socket) and make it current, run as the distro's default user. Pure.
pub(super) fn context_script(engine: &str) -> String {
    format!(
        r#"set -eu
D={TOOLS_DIR}/docker
"$D" context inspect {CONTEXT} >/dev/null 2>&1 || "$D" context create {CONTEXT} --description "Intentic's engine" --docker "host=unix:///mnt/wsl/{engine}/docker.sock" >/dev/null
"$D" context use {CONTEXT} >/dev/null
"#
    )
}

/// The `intentic-engine` context gone, the default one current again if it was ours. Pure.
pub(super) fn uncontext_script() -> String {
    format!(
        r#"set +e
D={TOOLS_DIR}/docker
[ -x "$D" ] || D=docker
[ "$("$D" context show 2>/dev/null)" = {CONTEXT} ] && "$D" context use default >/dev/null 2>&1
"$D" context rm -f {CONTEXT} >/dev/null 2>&1
exit 0
"#
    )
}

/// The distro's default user (whom `wsl -d <distro>` runs as), when it is not root.
fn default_user(distro: &str) -> Option<String> {
    wsl::run_wsl(
        &["-d", distro, "--exec", "id", "-un"],
        Duration::from_secs(30),
    )
    .ok()
    .map(|(_, out, _)| out.trim().to_string())
    .filter(|user| !user.is_empty() && user != "root")
}

fn as_user(distro: &str, user: &str, script: &str) -> Result<String, String> {
    let (code, stdout, stderr) = wsl::run_wsl(
        &["-d", distro, "-u", user, "--exec", "sh", "-c", script],
        Duration::from_secs(60),
    )?;
    if code != 0 {
        return Err(format!("in {distro}, as {user}: {}", stderr.trim()));
    }
    Ok(stdout)
}

pub fn enable(distro: &str) -> Result<(), String> {
    let mut record = record()?;
    if distro.eq_ignore_ascii_case(&record.distro) {
        return Err(format!("{distro} is the engine's own distro."));
    }
    if !wsl::distro_installed(distro) {
        return Err(format!(
            "there is no WSL distro named {distro} (wsl -l lists them)."
        ));
    }
    println!("Fetching the docker CLI, compose and buildx for {distro}…");
    let tgz = super::fetch::ensure_pinned(
        pins::DOCKER_LINUX_URL,
        &pins::linux_tgz_name(),
        pins::DOCKER_LINUX_SHA256,
    )?;
    let compose = super::fetch::ensure_pinned(
        pins::DOCKER_COMPOSE_URL,
        &pins::cached_name(pins::DOCKER_COMPOSE_URL),
        pins::DOCKER_COMPOSE_SHA256,
    )?;
    let buildx = super::fetch::ensure_pinned(
        pins::DOCKER_BUILDX_URL,
        &pins::cached_name(pins::DOCKER_BUILDX_URL),
        pins::DOCKER_BUILDX_SHA256,
    )?;
    println!("Installing them in {distro}…");
    let version = as_root(
        distro,
        &tools_script(
            &tgz.to_string_lossy(),
            &compose.to_string_lossy(),
            &buildx.to_string_lossy(),
        ),
        Duration::from_secs(300),
    )?;
    as_root(
        distro,
        "mkdir -p /usr/local/lib/intentic",
        Duration::from_secs(30),
    )?;
    super::windows::write_into_distro(distro, INTEGRATE_PATH, INTEGRATE)?;
    let systemd = as_root(distro, "cat /proc/1/comm", Duration::from_secs(30))
        .map(|comm| comm.trim() == "systemd")
        .unwrap_or(false);
    if systemd {
        super::windows::write_into_distro(distro, UNIT_PATH, &unit(&record.distro, distro))?;
        as_root(
            distro,
            &format!("chmod 644 {UNIT_PATH}; systemctl daemon-reload; systemctl enable intentic-engine-integration.service"),
            Duration::from_secs(60),
        )?;
    }
    // The distro's default user into its docker group, as Docker Desktop's integration expects of it too.
    let user = default_user(distro);
    let applied = apply(&record, distro)?;
    if let Some(user) = &user {
        let _ = as_root(
            distro,
            &format!("usermod -aG docker '{user}' 2>/dev/null || addgroup '{user}' docker 2>/dev/null || true"),
            Duration::from_secs(30),
        );
    }
    let foreign = applied.lines().any(|line| line.starts_with("foreign "));
    if foreign {
        match &user {
            Some(user) => as_user(distro, user, &context_script(&record.distro))
                .map(|_| ())
                .map_err(|problem| format!("could not make the {CONTEXT} docker context: {problem}"))?,
            None => println!(
                "Note: another engine serves {distro}'s /run/docker.sock and its default user is root: \
                 `docker context create {CONTEXT} --docker host=unix:///mnt/wsl/{}/docker.sock` reaches ours.",
                record.distro
            ),
        }
    }
    if !record
        .wsl
        .iter()
        .any(|known| known.eq_ignore_ascii_case(distro))
    {
        record.wsl.push(distro.to_string());
        record.save()?;
    }
    println!(
        "{distro} uses Intentic's engine as its Docker now: {}",
        version.trim()
    );
    if !systemd {
        println!(
            "Note: {distro} does not run systemd, so after it restarts its Docker comes back with the next `ic engine start`."
        );
    }
    if let (true, Some(user)) = (foreign, &user) {
        println!(
            "Another engine (Docker Desktop's WSL integration, or {distro}'s own dockerd) serves its /run/docker.sock \
             and keeps it: {user} reaches Intentic's engine through the docker context {CONTEXT}, now current, and \
             the other engine with `docker --context default`."
        );
    }
    if let Some(user) = &user {
        println!("{user} is in {distro}'s docker group; a shell opened before this needs reopening to have it.");
    }
    Ok(())
}

/// The distro's part, now: its /home shared, its socket linked (or a `foreign <socket>` line for one another engine
/// serves), the socket's group set. Answers what it printed.
pub fn apply(record: &EngineRecord, distro: &str) -> Result<String, String> {
    as_root(
        distro,
        &format!("{INTEGRATE_PATH} '{}' '{distro}'", record.distro),
        Duration::from_secs(60),
    )
}

/// Every distro the engine serves that is running now (a stopped one does its part when it starts): what
/// `ic engine start` does once the engine answers, since the engine may come up after the distro did.
pub fn apply_all(record: &EngineRecord, quiet: bool) {
    if record.wsl.is_empty() {
        return;
    }
    let running = wsl::running_distros();
    for distro in &record.wsl {
        if !running.iter().any(|name| name.eq_ignore_ascii_case(distro)) {
            continue;
        }
        if let Err(problem) = apply(record, distro) {
            if !quiet {
                println!("Note: {distro}'s Docker was not set up again ({problem}).");
            }
        }
    }
}

pub fn disable(distro: &str) -> Result<(), String> {
    let mut record = record()?;
    let engine = record.distro.clone();
    let script = format!(
        r#"set +e
systemctl disable intentic-engine-integration.service 2>/dev/null
rm -f {UNIT_PATH}
systemctl daemon-reload 2>/dev/null
for link in /run/docker.sock /var/run/docker.sock; do
  [ "$(readlink "$link" 2>/dev/null)" = "/mnt/wsl/{engine}/docker.sock" ] && rm -f "$link"
done
for link in /usr/local/bin/docker /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-buildx; do
  case "$(readlink "$link" 2>/dev/null)" in {TOOLS_DIR}/*) rm -f "$link" ;; esac
done
umount "/mnt/wsl/{engine}/distros/{distro}/home" 2>/dev/null
rmdir "/mnt/wsl/{engine}/distros/{distro}/home" "/mnt/wsl/{engine}/distros/{distro}" 2>/dev/null
rm -rf /usr/local/lib/intentic
exit 0
"#
    );
    if wsl::distro_installed(distro) {
        if let Some(user) = default_user(distro) {
            let _ = as_user(distro, &user, &uncontext_script());
        }
        as_root(distro, &script, Duration::from_secs(60))?;
    }
    record
        .wsl
        .retain(|known| !known.eq_ignore_ascii_case(distro));
    record.save()?;
    println!("{distro} no longer uses Intentic's engine as its Docker.");
    Ok(())
}

pub fn list() -> Result<(), String> {
    let record = record()?;
    if record.wsl.is_empty() {
        println!("No WSL distro uses Intentic's engine as its Docker. `ic engine wsl enable <distro>` sets one up.");
        return Ok(());
    }
    let running = wsl::running_distros();
    for distro in &record.wsl {
        let state = if running.iter().any(|name| name.eq_ignore_ascii_case(distro)) {
            "running"
        } else {
            "stopped"
        };
        println!("{distro} ({state}): Docker from Intentic's engine");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_unit_runs_the_integration_for_this_engine_and_distro_at_every_start() {
        let text = unit("intentic-engine", "Ubuntu");
        assert!(text.contains(
            "ExecStart=/usr/local/lib/intentic/engine-integration intentic-engine Ubuntu"
        ));
        assert!(text.contains("WantedBy=multi-user.target"));
        assert!(text.contains("Type=oneshot"));
    }

    #[test]
    fn the_tools_script_installs_from_the_cache_and_leaves_the_distros_own_docker_alone() {
        let script = tools_script(
            r"C:\Users\o'neil\c\docker.tgz",
            r"C:\c\compose",
            r"C:\c\buildx",
        );
        assert!(script.contains(r"wslpath -a 'C:\Users\o'\''neil\c\docker.tgz'"));
        assert!(script.contains("docker/docker"));
        assert!(script.contains("cli-plugins/$plugin"));
        // Only links into /mnt/wsl (an integration's) or ours are repointed, and Windows' PATH is never consulted.
        assert!(script.contains("/mnt/wsl/* | \"$DIR\"/*) return 0"));
        assert!(!script.contains("command -v docker"));
    }

    #[test]
    fn a_distro_another_engine_serves_reaches_ours_by_a_context_it_can_leave() {
        let make = context_script("intentic-engine");
        assert!(make.contains("context create intentic-engine"));
        assert!(make.contains("host=unix:///mnt/wsl/intentic-engine/docker.sock"));
        assert!(make.contains("context use intentic-engine"));
        // Made once: a second enable finds it.
        assert!(make.contains("context inspect intentic-engine >/dev/null 2>&1 ||"));
        let leave = uncontext_script();
        assert!(leave.contains("context use default"));
        assert!(leave.contains("context rm -f intentic-engine"));
    }

    #[test]
    fn the_integration_keeps_a_socket_another_engine_serves() {
        assert!(INTEGRATE.contains("echo \"foreign $sock\""));
        assert!(INTEGRATE.contains("[d]ocker-desktop-user-distro"));
    }
}
