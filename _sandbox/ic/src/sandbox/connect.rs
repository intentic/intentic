use crate::cloudflare;
use crate::contract::{self, RunRequest};
use crate::docker;
use crate::health;
use crate::logfile::Log;
use crate::platform;
use crate::sandbox::{container_status, list_slugs, remove, CONTAINER_PREFIX, TUNNEL_PREFIX};
use crate::tty;
use crate::util::{bail, kv_lines, slug_from_token, Result};

/* Run the AI-agent workspace sandbox on THIS machine and expose it to the browser — connect.sh/.ps1's
 * post-Docker half. The bootstrap shim keeps the one thing that genuinely needs a dependency-free start
 * (checking for Docker and installing it, with consent); everything after Docker lands here.
 *
 * The platform mints a per-project connection token and hands out a one-liner. This flow creates the
 * sandbox's OWN Cloudflare tunnel (or takes the platform-provisioned one), starts the published image as a
 * long-lived UNPRIVILEGED container (privileges only ever arrive later through owner-approved overlay
 * directives — the host's Docker socket is never mounted), and runs a cloudflared sidecar. The browser then
 * talks to the sandbox DIRECTLY over the tunnel; the platform stays off the command path. */

const ORIGIN_HOST: &str = "intentic-sandbox-workspace";

pub struct Args {
    pub setup_code: Option<String>,
    pub yes: bool,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn env_or(name: &str, fallback: &str) -> String {
    env(name).unwrap_or_else(|| fallback.to_string())
}

pub fn run(args: Args) -> Result<()> {
    println!("intentic: checking Docker…");
    docker::require_daemon()?;

    // Platform statics, overridden only for local dev against a non-prod platform. PLATFORM_URL is the API
    // origin the setup code is redeemed against — NOT the web-app origin (app.*), which serves only static
    // files and would 405 a POST.
    let platform_url = env_or("PLATFORM_URL", "https://api.intentic.dev");
    let google_client_id = env_or(
        "GOOGLE_CLIENT_ID",
        "481795963975-cq9msl6higcd91joidrfp8mjlkuq5fk3.apps.googleusercontent.com",
    );
    let web_origin = env_or("WEB_ORIGIN", "https://app.intentic.dev");
    let sandbox_image = env_or("SANDBOX_IMAGE", "ghcr.io/intentic/sandbox:stable");
    let preview_port = env_or("PREVIEW_PORT", "5173");
    let cloudflared_image = env_or("CLOUDFLARED_IMAGE", "cloudflare/cloudflared:2026.7.2");
    let sandbox_dns = env_or("SANDBOX_DNS", "1.1.1.1 1.0.0.1");
    let agent_auth_volume = env("INTENTIC_AGENT_AUTH_VOLUME");
    let sync_dir = env("SYNC_DIR");
    let self_host = env("SELF_HOST").is_some();

    let mut connect_token = env("CONNECT_TOKEN").unwrap_or_default();
    let mut tunnel_token = env("TUNNEL_TOKEN").unwrap_or_default();
    let mut sandbox_hostname = env("SANDBOX_HOSTNAME").unwrap_or_default();
    let mut zone = env("ZONE").unwrap_or_default();
    let mut subdomain = env("SUBDOMAIN").unwrap_or_default();
    let mut sync_pair_token = env("SYNC_PAIR_TOKEN").unwrap_or_default();
    let mut host_pair_token = env("HOST_PAIR_TOKEN").unwrap_or_default();
    let mut owner_email = env("OWNER_EMAIL").unwrap_or_default();
    let cf_token = env("CF_TOKEN").unwrap_or_default();

    // Redeem the setup code for the per-sandbox values. Env vars still work without a code
    // (headless/scripted installs). Redeemed after the Docker check so a docker-missing failure never burns
    // time against the code's TTL.
    if let Some(code) = args.setup_code.clone().or_else(|| env("SETUP_CODE")) {
        let claim = platform::claim(&platform_url, &code)?;
        connect_token = claim.connect_token.unwrap_or(connect_token);
        tunnel_token = claim.tunnel_token.unwrap_or(tunnel_token);
        sandbox_hostname = claim.sandbox_hostname.unwrap_or(sandbox_hostname);
        zone = claim.zone.unwrap_or(zone);
        subdomain = claim.subdomain.unwrap_or(subdomain);
        sync_pair_token = claim.sync_pair_token.unwrap_or(sync_pair_token);
        host_pair_token = claim.host_pair_token.unwrap_or(host_pair_token);
        owner_email = claim.owner_email.unwrap_or(owner_email);
    }
    // The platform can PRE-PROVISION the tunnel (the path for users with no Cloudflare of their own): both
    // values set means skip every Cloudflare call and just run the sandbox + cloudflared with the token.
    let provided_tunnel = !tunnel_token.is_empty() && !sandbox_hostname.is_empty();

    // Per-sandbox identity, so several sandboxes coexist: the slug is the same key the public hostname uses.
    let slug = if !subdomain.is_empty() {
        subdomain.clone()
    } else if provided_tunnel {
        sandbox_hostname.split('.').next().unwrap_or("").to_string()
    } else {
        slug_from_token(&connect_token)
    };
    let container = format!("{CONTAINER_PREFIX}{slug}");
    let tunnel_container = format!("{TUNNEL_PREFIX}{slug}");
    let network = format!("intentic-workspace-{slug}");

    // If OTHER sandboxes already exist, don't silently start one more beside them — surface them and let the
    // user continue, clean some up first, or quit. A same-slug re-run is a normal reset. Skipped with -y;
    // with no terminal we proceed (an explicitly requested create must not block automation).
    if !args.yes {
        let others: Vec<String> = list_slugs()
            .into_iter()
            .filter(|existing| *existing != slug)
            .collect();
        if !others.is_empty() {
            println!(
                "intentic: you already have {} other sandbox(es) on this machine:",
                others.len()
            );
            for other in &others {
                println!("  {:<9} {other}", container_status(other));
            }
            if tty::have_tty() {
                println!("This starts a NEW sandbox alongside them.");
                println!("  [c] continue (start alongside)");
                println!("  [r] remove some first…");
                println!("  [q] quit");
                match tty::ask("Choose [c/r/q]: ").as_deref() {
                    Some("r") | Some("R") => {
                        println!("intentic: opening cleanup…");
                        let _ = remove::run(remove::Args {
                            slugs: Vec::new(),
                            all: false,
                            yes: false,
                            agent_auth: false,
                        });
                        println!("intentic: continuing with this sandbox…");
                    }
                    Some("q") | Some("Q") | Some("") | None => {
                        println!("intentic: aborted — no sandbox started.");
                        return Ok(());
                    }
                    _ => {} // c (or anything else) → start alongside
                }
            } else {
                eprintln!("intentic: no terminal to prompt — starting alongside them (pass -y to silence this, or run cleanup first).");
            }
        }
    }

    let log = Log::create("connect")?;

    if connect_token.is_empty() {
        bail!("CONNECT_TOKEN is required (via the setup code or env) — copy the one-liner from the platform's setup screen.");
    }
    if provided_tunnel && self_host {
        bail!("SELF_HOST needs your own Cloudflare API token (CF_TOKEN). On an intentic-provided sandbox,\n       connect this machine from the workspace's Infra screen instead — its one-liner needs no\n       Cloudflare token.");
    }
    // Cloudflare is intentic's reachability fabric, so the token is required and validated up front rather
    // than failing later at `intentic deploy apply`. It never reaches the platform — it rides into the
    // sandbox below as the Cloudflare-standard CLOUDFLARE_API_TOKEN.
    if !provided_tunnel && cf_token.is_empty() {
        bail!("CF_TOKEN is required — Cloudflare is intentic's reachability fabric (the tunnel that\n       connects your services and exposes them). Create a token at\n       https://dash.cloudflare.com/profile/api-tokens with: Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit.");
    }
    if !cf_token.is_empty() {
        cloudflare::validate_token(&cf_token)?;
    }
    if !provided_tunnel && zone.is_empty() {
        zone = cloudflare::resolve_zone(&cf_token, "your sandbox")?;
    }

    // When requested, wire this machine as a deploy target before starting the sandbox — HOST_SSH_KEY and
    // SELF_HOST_* ride into the container's env below. Two shapes for one idea: Linux/macOS registers the
    // machine itself (service user + sshd + host tunnel); Windows can't be a native SSH+Docker target, so a
    // privileged Docker-in-Docker "host" container stands in as the deploy target instead.
    let mut host_ssh_key = env("HOST_SSH_KEY").unwrap_or_default();
    let mut self_host_user = env("SELF_HOST_USER").unwrap_or_default();
    let mut self_host_address = String::new();
    // The via names the transport to a self-host target. Windows never sets one: its dind target is reached
    // directly by name on the shared network, so there is no via to send (hence the unused-mut allow there).
    #[cfg_attr(windows, allow(unused_mut))]
    let mut self_host_via = String::new();
    #[cfg(unix)]
    if self_host {
        let root = crate::selfhost::Root::acquire("SELF_HOST setup")?;
        let user = if self_host_user.is_empty() {
            "intentic".to_string()
        } else {
            self_host_user.clone()
        };
        host_ssh_key = crate::selfhost::setup_service_user(&root, &user, "intentic-self-host")?;
        self_host_user = user;
        println!(
            "intentic: this server is registered as a deploy target (user '{self_host_user}')."
        );
    }

    // Resolve the image up front (a slow first pull shouldn't look like a hang) — and the tunnel step below,
    // which runs this same image via `--entrypoint intentic`, must never execute a stale locally-cached tag.
    ensure_image(&sandbox_image, &log)?;

    // The sandbox tunnel: platform-provisioned (nothing to do but record the URL), or minted with the
    // user's token by the bundled CLI — the logic lives in the image, this flow only carries the answer.
    let sandbox_public_url;
    if provided_tunnel {
        sandbox_public_url = format!("https://{sandbox_hostname}");
    } else {
        println!("intentic: creating the sandbox tunnel…");
        let mut tunnel_args: Vec<String> = vec![
            "run".into(),
            "--rm".into(),
            "--entrypoint".into(),
            "intentic".into(),
            "-e".into(),
            format!("CLOUDFLARE_API_TOKEN={cf_token}"),
            "-e".into(),
            format!("CONNECT_TOKEN={connect_token}"),
        ];
        if !zone.is_empty() {
            tunnel_args.push("-e".into());
            tunnel_args.push(format!("ZONE={zone}"));
        }
        tunnel_args.extend([
            sandbox_image.clone(),
            "tunnel".into(),
            "sandbox".into(),
            "--service".into(),
            format!("http://{ORIGIN_HOST}:8787"),
            "--preview-service".into(),
            format!("http://{ORIGIN_HOST}:{preview_port}"),
            "--ssh-service".into(),
            format!("ssh://{ORIGIN_HOST}:22"),
        ]);
        if !subdomain.is_empty() {
            tunnel_args.push("--subdomain".into());
            tunnel_args.push(subdomain.clone());
        }
        let arg_refs: Vec<&str> = tunnel_args.iter().map(String::as_str).collect();
        let tunnel_out = docker::capture(&arg_refs).map_err(|err| {
            crate::util::Fail(format!("failed to create the sandbox tunnel: {}", err.0))
        })?;
        let lookup = kv_lines(&tunnel_out);
        tunnel_token = lookup("TUNNEL_TOKEN").unwrap_or_default();
        sandbox_hostname = lookup("SANDBOX_HOSTNAME").unwrap_or_default();
        if tunnel_token.is_empty() || sandbox_hostname.is_empty() {
            bail!("failed to create the sandbox tunnel (see the output above).");
        }
        sandbox_public_url = format!("https://{sandbox_hostname}");
    }

    // Expose THIS machine's sshd over its own tunnel so the sandbox can deploy to it through `cloudflared
    // access` — a NAT'd local machine the sandbox can't reach by IP.
    #[cfg(unix)]
    if self_host {
        println!("intentic: creating the host SSH tunnel…");
        let mut host_args: Vec<String> = vec![
            "run".into(),
            "--rm".into(),
            "--entrypoint".into(),
            "intentic".into(),
            "-e".into(),
            format!("CLOUDFLARE_API_TOKEN={cf_token}"),
            "-e".into(),
            format!("CONNECT_TOKEN={connect_token}"),
        ];
        if !zone.is_empty() {
            host_args.push("-e".into());
            host_args.push(format!("ZONE={zone}"));
        }
        host_args.extend([sandbox_image.clone(), "tunnel".into(), "host".into()]);
        let arg_refs: Vec<&str> = host_args.iter().map(String::as_str).collect();
        let host_out = docker::capture(&arg_refs).map_err(|err| {
            crate::util::Fail(format!("failed to create the host SSH tunnel: {}", err.0))
        })?;
        let lookup = kv_lines(&host_out);
        let host_tunnel_token = lookup("HOST_SSH_TUNNEL_TOKEN").unwrap_or_default();
        self_host_address = lookup("HOST_SSH_HOSTNAME").unwrap_or_default();
        if host_tunnel_token.is_empty() || self_host_address.is_empty() {
            bail!("failed to create the host SSH tunnel (see the output above).");
        }
        self_host_via = "cloudflared".to_string();
        let root = crate::selfhost::Root::acquire("SELF_HOST setup")?;
        let cloudflared_version = env_or("CLOUDFLARED_VERSION", "2026.7.2");
        crate::selfhost::install_cloudflared(&root, &cloudflared_version)?;
        crate::selfhost::run_ssh_connector(&root, &host_tunnel_token, "the connect one-liner")?;
        println!(
            "intentic: this host's SSH is reachable through the tunnel at {self_host_address}."
        );
    }

    println!("intentic: starting sandbox…");
    // cloudflared (the sidecar below) reaches the sandbox by name on this shared network; create it first.
    if !docker::ok(&["network", "inspect", &network]) {
        docker::capture(&["network", "create", &network])?;
    }
    docker::quiet(&["rm", "-f", &container]);

    // Windows self-host: the Docker-in-Docker deploy target, ALONGSIDE the sandbox on Docker Desktop, not
    // inside it — the control plane stays an unprivileged container outside its (privileged) targets, and it
    // reaches this one over SSH by name on the shared network. The key is generated INSIDE the target.
    #[cfg(windows)]
    if self_host {
        let (key, user, address) = start_dind_target(&slug, &network, &log)?;
        host_ssh_key = key;
        self_host_user = user;
        self_host_address = address;
    }

    // The platform as seen FROM the container, for the daemon's announce (URL + liveness phone-home).
    let platform_url_container = platform_url
        .replace("//localhost", "//host.docker.internal")
        .replace("//127.0.0.1", "//host.docker.internal");

    // HOW THE CONTAINER IS RUN is not written here — see contract.rs. The pairs go in NUL-framed (empties
    // dropped CLI-side, where an empty secret would shadow the workspace .env the user writes later).
    let env_pairs = crate::util::nul_frame(&[
        ("PREVIEW_PORT", &preview_port),
        ("GOOGLE_CLIENT_ID", &google_client_id),
        ("CONNECT_TOKEN", &connect_token),
        ("OWNER_EMAIL", &owner_email),
        ("WEB_ORIGIN", &web_origin),
        ("SANDBOX_PUBLIC_URL", &sandbox_public_url),
        ("PLATFORM_URL", &platform_url_container),
        ("SYNC_PAIR_TOKEN", &sync_pair_token),
        // The connected-computer seed: the pairing the machine agent below redeems, plus what to call this
        // machine and which OS card it gets. The daemon cannot learn either for itself — it is in a container
        // with its own hostname, on a Linux however this machine is spelled.
        ("HOST_PAIR_TOKEN", &host_pair_token),
        ("HOST_PLATFORM", host_platform()),
        ("HOST_LABEL", &machine_label()),
        ("CLOUDFLARE_API_TOKEN", &cf_token),
        ("HOST_SSH_KEY", &host_ssh_key),
        ("SELF_HOST_USER", &self_host_user),
        ("SELF_HOST_ADDRESS", &self_host_address),
        ("SELF_HOST_VIA", &self_host_via),
        (
            "AGENT_AUTH_DIR",
            if agent_auth_volume.is_some() {
                "/agent-auth"
            } else {
                ""
            },
        ),
    ]);
    let mounts = agent_auth_volume
        .as_ref()
        .map(|volume| format!("{volume}:/agent-auth"));
    let request = RunRequest {
        image: &sandbox_image,
        slug: &slug,
        base_image: &sandbox_image,
        channel: None,
        previous_image: None,
        environment_hash: None,
        runtime: None,
        mounts: mounts.as_deref(),
        dns: (!sandbox_dns.is_empty()).then_some(sandbox_dns.as_str()),
    };
    let argv = contract::run_command(&request, &env_pairs, false, &[], &log)?;
    log.section(&format!("docker run {sandbox_image}"));
    // Two attempts: the loopback shortcut (127.0.0.1:<derived port>:8787, a browser on this machine skipping
    // the tunnel) is the one part whose failure doesn't mean a broken sandbox — docker refuses the WHOLE
    // launch when the port is held, so the retry drops just the shortcut.
    if !docker::run_argv(&argv, &log) {
        docker::quiet(&["rm", "-f", &container]);
        let retry = contract::run_command(&request, &env_pairs, true, &[], &log)?;
        if !docker::run_argv(&retry, &log) {
            let tail = log.tail(5);
            bail!(
                "starting the sandbox failed — the full docker error is saved to {}.\n{tail}",
                log.path.display()
            );
        }
        println!("intentic: started without the local shortcut (its port is taken) — this browser reaches the sandbox over its tunnel.");
    }

    // The tunnel connector: cloudflared on the shared network routes sandbox-<id>.<zone> → the daemon and
    // the preview hostnames → the preview proxy. It retries until the sandbox is up, so ordering is loose.
    println!("intentic: starting the sandbox tunnel connector…");
    docker::quiet(&["rm", "-f", &tunnel_container]);
    let sidecar = [
        "run",
        "-d",
        "--restart",
        "unless-stopped",
        "--name",
        &tunnel_container,
        "--network",
        &network,
        "--log-opt",
        "max-size=10m",
        "--log-opt",
        "max-file=3",
        &cloudflared_image,
        "tunnel",
        "--no-autoupdate",
        "run",
        "--token",
        &tunnel_token,
    ];
    if let Err(err) = docker::capture(&sidecar) {
        log.line(&err.0);
    }

    println!("intentic: waiting for the sandbox daemon to come up…");
    health::wait_answering(&container, &log, "")?;

    println!("intentic sandbox started.");
    println!("Your sandbox will be reachable at {sandbox_public_url} (DNS may take a few seconds to propagate).");
    println!(
        "Return to the platform — your sandbox announces itself and setup continues automatically."
    );

    // Desktop sync chosen at setup: the same paste covers it, gated on the SYNC_DIR opt-in the command
    // carried. Runs after the "return to the platform" lines — the wizard's live gate flips on the sandbox
    // itself, independent of this stage — and never fails the setup.
    if let (Some(dir), false) = (sync_dir, sync_pair_token.is_empty()) {
        if !run_desktop_sync(&container, &sandbox_public_url, &sync_pair_token, &dir) {
            eprintln!("intentic: warning — desktop sync didn't finish. Your sandbox is fine; enable sync any time from the workspace's Desktop sync card.");
        }
    }

    /* Connect this machine as a computer — not gated on an opt-in, unlike sync above, because it needs no
     * decision from the user: sync asks which FOLDER to mirror and there is no sensible default for that, while
     * this asks for nothing and grants only what the machine already does for this sandbox. The permission it
     * arrives with covers this machine's sandboxes and nothing else, and it is stated on the card.
     *
     * Never fails the setup. A machine that does not finish this is a machine whose Computers view says its
     * sandboxes are not visible — exactly what every sandbox said before this existed. */
    if !host_pair_token.is_empty()
        && !run_host_agent(&container, &sandbox_public_url, &host_pair_token)
    {
        eprintln!("intentic: warning — this computer wasn't connected, so its sandboxes won't be manageable from your browser. Add it any time from Capabilities.");
    }

    if !self_host {
        println!("Reachable only — no deploy target. To deploy an app onto this machine later, re-run with SELF_HOST=1 (needs sudo).");
    }
    println!(
        "Logs: docker logs -f {container} (connect logs: {})",
        crate::logfile::log_dir().display()
    );
    println!("Stop (keeps your /work): docker stop {container} {tunnel_container}");
    println!("Reset this sandbox (also removes its /work volume): ic sandbox remove {slug} -y");
    Ok(())
}

/// Does this reference carry an explicit registry host? The part before the first `/` counts as one when it
/// looks like a hostname — it contains a `.` or a `:port`, or it is `localhost`. A bare name like
/// `intentic-sandbox:dev` has none (its `:` is the TAG separator, not a port), so docker would resolve it
/// against Docker Hub — which is why such a reference is never pulled: that pull can only ever fail, and its
/// "denied" output is pure noise on top of a dev image that is sitting right there locally.
fn is_registryless(image: &str) -> bool {
    match image.split('/').next() {
        Some(first) if image.contains('/') => {
            !(first.contains('.') || first.contains(':') || first == "localhost")
        }
        _ => true,
    }
}

/// Make the image runnable. A registry-less reference (a dev tag like intentic-sandbox:dev) can only resolve
/// to Docker Hub, so it is never pulled — it runs the local build (the dev wrapper is what rebuilds it from a
/// checkout; this binary ships without one). Registry images are pulled even when cached so the moving
/// `stable` tag always runs the newest release.
fn ensure_image(image: &str, log: &Log) -> Result<()> {
    if is_registryless(image) {
        if docker::image_exists(image) {
            println!("intentic: using the existing local sandbox image {image}.");
            return Ok(());
        }
        bail!("'{image}' is a local dev tag that isn't built — run 'pnpm build:sandbox' in the intentic repo (or its dev-sandbox wrapper), or unset SANDBOX_IMAGE to use the published image.");
    }
    println!("intentic: pulling sandbox image {image} (first run can take a minute)…");
    docker::pull(image, log)
}

/// Wait for the daemon INSIDE the container (no tunnel/DNS in the loop), then run the standard sync
/// bootstrap — as the INVOKING user when running under sudo: the agent is per-user state (~/.intentic, the
/// user's Mutagen daemon). The sync agent connects over the public URL and retries transient tunnel errors
/// itself, so this local gate need not wait for the tunnel.
fn run_desktop_sync(container: &str, public_url: &str, pair_token: &str, sync_dir: &str) -> bool {
    println!("intentic: waiting for your sandbox to come online to set up desktop sync…");
    if !wait_local_health(container) {
        return false;
    }
    run_agent_bootstrap(
        AgentBootstrap {
            what: "desktop sync",
            url_var: "SYNC_SCRIPT_URL",
            unix_url: "https://intentic.dev/sync",
            windows_url: "https://intentic.dev/sync.ps1",
        },
        &[
            ("SANDBOX_URL", public_url),
            ("PAIR_TOKEN", pair_token),
            ("SYNC_DIR", sync_dir),
        ],
    )
}

/// Connect this machine as a COMPUTER, so its sandboxes can be seen and managed from the browser.
///
/// The same bootstrap as desktop sync above and deliberately so — it is the second half of the same promise.
/// Sync makes the machine's FOLDERS reachable from the sandbox; this makes the machine's own fleet reachable,
/// which is the half that used to require a terminal on this exact machine even to restart the sandbox that
/// had wedged.
///
/// What the sandbox may then do here is decided in the sandbox and enforced by the agent this installs: it
/// arrives allowed to start, stop and update this machine's sandboxes and nothing else — no shell, no files,
/// no screen. Widening it is a switch on the computer's own card.
fn run_host_agent(container: &str, public_url: &str, pair_token: &str) -> bool {
    println!(
        "intentic: connecting this computer so you can manage its sandboxes from your browser…"
    );
    if !wait_local_health(container) {
        return false;
    }
    run_agent_bootstrap(
        AgentBootstrap {
            what: "this computer",
            url_var: "HOST_SCRIPT_URL",
            unix_url: "https://intentic.dev/computer",
            windows_url: "https://intentic.dev/computer.ps1",
        },
        &[("SANDBOX_URL", public_url), ("PAIR_TOKEN", pair_token)],
    )
}

/// Wait for the daemon INSIDE the container — no tunnel and no DNS in the loop. Both agents connect over the
/// PUBLIC url and retry transient tunnel errors themselves, so this local gate only has to know that the daemon
/// is up at all.
fn wait_local_health(container: &str) -> bool {
    for _ in 0..60 {
        if docker::exec_ok(
            container,
            &["curl", "-fsS", "--max-time", "5", "localhost:8787/health"],
        ) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
    }
    false
}

/// Which served installer to run, and what to call it when it does not finish.
struct AgentBootstrap {
    what: &'static str,
    url_var: &'static str,
    unix_url: &'static str,
    windows_url: &'static str,
}

/// Run one of the served agent installers, as the INVOKING user when this is running under sudo: both agents are
/// per-user state (~/.intentic, the user's own login entry, the user's Mutagen daemon), and one installed for
/// root is one that never starts again for the person who ran setup.
fn run_agent_bootstrap(agent: AgentBootstrap, vars: &[(&str, &str)]) -> bool {
    // Chosen with `cfg!` rather than a `#[cfg]` block, so BOTH spellings are compiled on either host — this
    // binary is cross-built, and a Windows url that only exists on a Windows build is one no Linux runner can
    // ever check. Only the process mechanics below genuinely differ per platform.
    let url = env_or(
        agent.url_var,
        if cfg!(windows) {
            agent.windows_url
        } else {
            agent.unix_url
        },
    );
    #[cfg(unix)]
    {
        // Fetch before piping — a failed fetch must fail the bootstrap, not feed sh half a script.
        let Ok(mut response) = ureq::get(&url).call() else {
            return false;
        };
        let Ok(script) = response.body_mut().read_to_string() else {
            return false;
        };
        let mut cmd = match (
            docker::is_root(),
            std::env::var("SUDO_USER")
                .ok()
                .filter(|user| !user.is_empty()),
        ) {
            (true, Some(user)) => {
                let mut sudo = std::process::Command::new("sudo");
                sudo.args(["-u", &user, "-H", "sh"]);
                sudo
            }
            (true, None) => {
                eprintln!(
                    "intentic: skipping {} — running as root with no invoking user to install it for.",
                    agent.what
                );
                return false;
            }
            _ => std::process::Command::new("sh"),
        };
        for (key, value) in vars {
            cmd.env(key, value);
        }
        cmd.stdin(std::process::Stdio::piped());
        let Ok(mut child) = cmd.spawn() else {
            return false;
        };
        use std::io::Write;
        if child
            .stdin
            .take()
            .and_then(|mut stdin| stdin.write_all(script.as_bytes()).ok())
            .is_none()
        {
            return false;
        }
        child.wait().map(|status| status.success()).unwrap_or(false)
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", &format!("irm {url} | iex")]);
        for (key, value) in vars {
            cmd.env(key, value);
        }
        cmd.status().map(|status| status.success()).unwrap_or(false)
    }
}

/// The card this machine gets in the sandbox — one of the OS slugs the bundled computers extension declares.
fn host_platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

/// What to call this machine in the sandbox's UI, and how the agent will address it ("run the tests on
/// ada-laptop"). The hostname is what a person recognises; the daemon cannot read it for itself, since inside
/// the container the hostname is the container's own.
///
/// Read without a crate for it, because every source here is already one line and a dependency in this binary is
/// a dependency in every setup that runs it. `COMPUTERNAME` is always set on Windows, `/etc/hostname` is the
/// standard file everywhere else, and the command is the fallback for a system that has neither.
fn machine_label() -> String {
    let named = |value: String| Some(value).filter(|name| !name.trim().is_empty());
    std::env::var("HOST_LABEL")
        .ok()
        .and_then(named)
        .or_else(|| std::env::var("COMPUTERNAME").ok().and_then(named))
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .and_then(named)
        })
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .filter(|out| out.status.success())
                .and_then(|out| String::from_utf8(out.stdout).ok())
                .and_then(named)
        })
        .map(|name| name.trim().to_string())
        .unwrap_or_else(|| "this-computer".to_string())
}

/// The Windows deploy target: a privileged dind-host container on the shared network. Returns the private
/// key, user and address the sandbox will deploy through.
#[cfg(windows)]
fn start_dind_target(slug: &str, network: &str, log: &Log) -> Result<(String, String, String)> {
    use crate::sandbox::DIND_PREFIX;
    let dind_container = format!("{DIND_PREFIX}{slug}");
    let dind_image = env_or("DIND_IMAGE", "ghcr.io/intentic/dind-host:latest");
    let dind_volume = format!("intentic-dind-docker-{slug}");
    println!("intentic: starting the Docker-in-Docker deploy target…");
    docker::quiet(&["rm", "-f", &dind_container]);
    let run = [
        "run",
        "-d",
        "--privileged",
        "--restart",
        "unless-stopped",
        "--name",
        &dind_container,
        "--network",
        network,
        "-e",
        "DOCKER_TLS_CERTDIR=",
        "-v",
        &format!("{dind_volume}:/var/lib/docker"),
        "--dns",
        "1.1.1.1",
        "--dns",
        "1.0.0.1",
        &dind_image,
    ];
    docker::capture(&run).map_err(|err| {
        crate::util::Fail(format!(
            "failed to start the Docker-in-Docker deploy target: {}",
            err.0
        ))
    })?;
    for _ in 0..60 {
        if docker::exec_ok(&dind_container, &["true"]) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    // A fresh ed25519 key inside the target, authorized as its only key (root-owned, 600 — sshd rejects
    // loose modes); the private half rides into the sandbox as HOST_SSH_KEY.
    if !docker::exec_ok(
        &dind_container,
        &[
            "sh",
            "-c",
            "ssh-keygen -t ed25519 -N \"\" -C intentic-dind -f /root/.ssh/intentic_ed25519 >/dev/null && cat /root/.ssh/intentic_ed25519.pub > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys",
        ],
    ) {
        bail!("failed to provision the deploy target's SSH key (log: {}).", log.path.display());
    }
    let key = docker::exec_capture(&dind_container, &["cat", "/root/.ssh/intentic_ed25519"])
        .ok_or_else(|| {
            crate::util::Fail("could not read the deploy target's SSH key".to_string())
        })?;
    println!("intentic: deploy target '{dind_container}' is ready (the sandbox reaches it over SSH on the shared network).");
    Ok((key, "root".to_string(), dind_container))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dev_tag_is_registryless_and_a_published_image_is_not() {
        // Published references: pulled, so the moving `stable` tag always runs the newest release.
        assert!(!is_registryless("ghcr.io/intentic/sandbox:stable"));
        assert!(!is_registryless("docker.io/library/alpine:3"));
        // Dev tags: never pulled. Docker would resolve these against Docker Hub, where the pull can only
        // fail — and its "denied" output reads as a real problem on top of a working local image.
        assert!(is_registryless("intentic-sandbox:dev"));
        assert!(is_registryless("intentic-sandbox-env-abc:0123456789ab"));
        assert!(is_registryless("alpine"));
        // A bare namespaced name is still Docker Hub's — `library/alpine` has no registry host.
        assert!(is_registryless("library/alpine:3"));
    }

    #[test]
    fn a_registry_host_is_recognised_by_a_dot_a_port_or_localhost() {
        // The three shapes docker itself treats as a registry host.
        assert!(!is_registryless("registry.example.com/team/img:1"));
        assert!(!is_registryless("localhost/img:dev"));
        assert!(!is_registryless("localhost:5000/img:dev"));
        assert!(!is_registryless("127.0.0.1:5000/img"));
        // The trap this function exists for: a TAG colon is not a port. `intentic-sandbox:dev` has a colon
        // but no slash, so reading "contains a colon" alone would call it a registry and try to pull it.
        assert!(is_registryless("intentic-sandbox:dev"));
    }
}
