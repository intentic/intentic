use crate::checks;
use crate::cloudflare;
use crate::contract::{self, RunRequest};
use crate::docker;
use crate::health;
use crate::logfile::Log;
use crate::platform;
use crate::record::{ChannelRecord, Phase, Swap};
use crate::sandbox::recreate::{self, Restored};
use crate::sandbox::side::{self, Side};
use crate::sandbox::{
    container_status, doctor, list_slugs, lock, mirror, now_ms, project_dir, remove, resume,
    CONTAINER_PREFIX, PARKED_SUFFIX,
};
use crate::tty;
use crate::ui;
use crate::util;
use crate::util::{bail, kv_lines, slug_from_token, step, Result};

/* Run the AI-agent workspace sandbox on THIS machine and expose it to the browser — connect.sh/.ps1's post-Docker half. */

pub struct Args {
    pub setup_code: Option<String>,
    pub yes: bool,
    /// Reinstall a sandbox this machine already has, keeping what it was set up as (see `existing`).
    pub replace: bool,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

pub(crate) fn env_or(name: &str, fallback: &str) -> String {
    env(name).unwrap_or_else(|| fallback.to_string())
}

pub fn run(args: Args) -> Result<()> {
    // Platform statics, overridden only for local dev against a non-prod platform. PLATFORM_URL is the API
    // origin the setup code is redeemed against — NOT the web-app origin (app.*), which serves only static
    // files and would 405 a POST.
    let platform_url = env_or("PLATFORM_URL", "https://api.intentic.dev");
    let setup_code = args.setup_code.clone().or_else(|| env("SETUP_CODE"));

    /* The one seam every setup failure passes through. */
    let reporter = platform::Reporter::new(&platform_url, setup_code.clone());
    let result = connect(args, &platform_url, setup_code, &reporter);
    if let Err(fail) = &result {
        reporter.failure(&fail.0);
    }
    result
}

fn connect(
    args: Args,
    platform_url: &str,
    setup_code: Option<String>,
    reporter: &platform::Reporter,
) -> Result<()> {
    let google_client_id = env_or(
        "GOOGLE_CLIENT_ID",
        "481795963975-cq9msl6higcd91joidrfp8mjlkuq5fk3.apps.googleusercontent.com",
    );
    let web_origin = env_or("WEB_ORIGIN", "https://app.intentic.dev");
    let mut sandbox_image = env_or("SANDBOX_IMAGE", "ghcr.io/intentic/sandbox:stable");
    let preview_port = env_or("PREVIEW_PORT", "5173");
    let mut sandbox_dns = env_or("SANDBOX_DNS", "1.1.1.1 1.0.0.1");
    let agent_auth_volume = env("INTENTIC_AGENT_AUTH_VOLUME");
    let sync_dir = env("SYNC_DIR");
    // A project sandbox's folder (a sandbox made for one folder), refused before anything starts when it is not a shape
    // the sync agent accepts: a wrong one would sync the owner's folder somewhere they were not told. SYNC_PROJECTS_HOST
    // is the other shape, this computer's own sandbox that folders attach to later, and takes none of those variables.
    let placement = if env("SYNC_PROJECTS_HOST").is_some() {
        project_dir::projects_host(
            env("SYNC_REMOTE_DIR").as_deref(),
            env("SYNC_PROJECT").is_some(),
            sync_dir.is_some(),
        )
    } else {
        project_dir::placement(
            env("SYNC_REMOTE_DIR").as_deref(),
            env("SYNC_PROJECT").is_some(),
            sync_dir.is_some(),
        )
    }?;
    let self_host = env("SELF_HOST").is_some();

    let mut connect_token = env("CONNECT_TOKEN").unwrap_or_default();
    /* The reachability grant names this sandbox and the edge that presents it to the daemon. */
    let mut sandbox_grant = env("SANDBOX_GRANT").unwrap_or_default();
    let mut ingress_url = env("INGRESS_URL").unwrap_or_default();
    let mut sandbox_hostname = env("SANDBOX_HOSTNAME").unwrap_or_default();
    // Only SELF_HOST needs a zone now: it publishes THIS machine's sshd for the deploy engine, on the user's
    // own Cloudflare. The sandbox's own address comes from the platform's edge.
    let mut zone = env("ZONE").unwrap_or_default();
    let mut sync_pair_token = env("SYNC_PAIR_TOKEN").unwrap_or_default();
    let mut host_pair_token = env("HOST_PAIR_TOKEN").unwrap_or_default();
    let mut owner_email = env("OWNER_EMAIL").unwrap_or_default();
    let mut definition_seed = env("SANDBOX_DEFINITION_SEED").unwrap_or_default();
    let cf_token = env("CF_TOKEN").unwrap_or_default();

    /* Same idea and the same phase vocabulary as the desktop app's own plan (desktop-app/src/setupPlan.ts). */
    let mut plan = vec![ui::PlanStep {
        phase: "preflight",
        label: "Check this device",
        weight: 10,
    }];
    if setup_code.is_some() {
        plan.push(ui::PlanStep {
            phase: "claiming-code",
            label: "Redeem your setup code",
            weight: 5,
        });
    }
    plan.push(ui::PlanStep {
        phase: "pulling-image",
        label: "Download the sandbox image",
        weight: 240,
    });
    if self_host && cfg!(unix) {
        plan.push(ui::PlanStep {
            phase: "creating-tunnel",
            label: "Publish this machine's SSH",
            weight: 30,
        });
    }
    plan.extend([
        ui::PlanStep {
            phase: "starting-sandbox",
            label: "Start your sandbox",
            weight: 25,
        },
        ui::PlanStep {
            phase: "waiting-health",
            label: "Wait for it to come up",
            weight: 40,
        },
        ui::PlanStep {
            phase: "verifying",
            label: "Check it answers",
            weight: 20,
        },
    ]);
    if placement.syncs(sync_dir.is_some()) {
        plan.push(ui::PlanStep {
            phase: "desktop-sync",
            label: "Set up folder sync",
            weight: 45,
        });
    }
    plan.push(ui::PlanStep {
        phase: "connecting-machine",
        label: "Connect this device",
        weight: 20,
    });
    ui::begin("intentic · setting up your sandbox", plan);

    /* PREFLIGHT — every prerequisite verified read-only, every failure reported at once. */
    let mut list = vec![
        checks::Check::new("Docker", checks::check_docker),
        checks::Check::new("Disk space", checks::check_disk),
    ];
    // Windows only, and FIRST among the machine checks in the report: when a PC cannot virtualize, "docker is
    // not installed" is a true sentence about a consequence, and the reader needs the cause. checks::check_windows
    // explains why this is worth a second even on the path where the shim already fixed everything.
    #[cfg(windows)]
    list.insert(0, checks::Check::new("This PC", checks::check_windows));
    // Only when this run actually speaks to the platform — the code's claim, and the wizard's reports that
    // ride the same code. A codeless run carries its tokens in the env and never calls the origin, so
    // probing it would fail a setup on an address nothing was going to use. Same shape as the Cloudflare
    // token below: a prerequisite is checked when it is one.
    if setup_code.is_some() {
        let for_probe = platform_url.to_string();
        list.push(checks::Check::new("Platform reachable", move || {
            checks::check_platform(&for_probe)
        }));
    }
    if !cf_token.is_empty() {
        let token = cf_token.clone();
        list.push(checks::Check::new("Cloudflare token", move || {
            checks::check_cloudflare(&token)
        }));
    }
    let findings = checks::run("preflight", "preflight — checking this machine…", list);
    if let Some(summary) = checks::failure_summary(&findings) {
        reporter.findings_failed("preflight", checks::wire_failures(&findings));
        bail!("{summary}");
    }

    // Redeem the setup code for the per-sandbox values. Env vars still work without a code
    // (headless/scripted installs). Redeemed after the preflight so a broken machine never burns
    // time against the code's TTL.
    if let Some(code) = &setup_code {
        let claim = platform::claim(platform_url, code)?;
        connect_token = claim.connect_token.unwrap_or(connect_token);
        sandbox_grant = claim.sandbox_grant.unwrap_or(sandbox_grant);
        ingress_url = claim.ingress_url.unwrap_or(ingress_url);
        sandbox_hostname = claim.sandbox_hostname.unwrap_or(sandbox_hostname);
        sync_pair_token = claim.sync_pair_token.unwrap_or(sync_pair_token);
        host_pair_token = claim.host_pair_token.unwrap_or(host_pair_token);
        owner_email = claim.owner_email.unwrap_or(owner_email);
        definition_seed = claim.definition_seed.unwrap_or(definition_seed);
    }
    /* Reachability is the platform's own edge now, and provisioning it is a pure function there. */
    let has_public_name = !sandbox_hostname.is_empty();

    // Per-sandbox identity, so several sandboxes coexist: the slug is the same key the public hostname uses.
    let slug = if has_public_name {
        sandbox_hostname.split('.').next().unwrap_or("").to_string()
    } else {
        slug_from_token(&connect_token)
    };
    let container = format!("{CONTAINER_PREFIX}{slug}");
    let parked = format!("{container}{PARKED_SUFFIX}");

    /* A SANDBOX THIS MACHINE ALREADY HAS IS NOT SET UP AGAIN BY ACCIDENT. Connect is a whole install: run over a live
    sandbox it used to remove the container and start the stock image in its place, with none of what the sandbox was
    (its logins volume, its dev mounts, its web origin, its device), and -y skipped the one question (2026-10-07). */
    let replacing = match existing(
        docker::container_exists(&container) || docker::container_exists(&parked),
        args.replace,
        args.yes,
        || {
            ui::suspend();
            println!("\nintentic: sandbox {slug} already exists on this machine.");
            println!("Setting it up again recreates its container from this setup, and keeps its files, history, logins, settings and device.");
            let yes = tty::confirm("Recreate it?", false);
            println!();
            ui::resume();
            yes
        },
    ) {
        Existing::None => None,
        Existing::Refuse => bail!("{}", refusal(&slug)),
        Existing::Replace => Some(Replacing::take(&slug, &container, &parked)?),
    };

    // If OTHER sandboxes already exist, don't silently start one more beside them — surface them and let the
    // user continue, clean some up first, or quit. A same-slug re-run was settled above. Skipped with -y;
    // with no terminal we proceed (an explicitly requested create must not block automation).
    if !args.yes {
        let others: Vec<String> = list_slugs()
            .into_iter()
            .filter(|existing| *existing != slug)
            .collect();
        if !others.is_empty() {
            // A question owns the screen while it is asked: the live step line is erased first and redrawn
            // after, or the spinner repaints straight over what the user is being asked to read.
            ui::suspend();
            println!(
                "\nintentic: you already have {} on this machine:",
                util::plural(others.len(), "other sandbox")
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
                            now: false,
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
            println!();
            ui::resume();
        }
    }

    let log = Log::create("connect")?;

    if connect_token.is_empty() {
        bail!("CONNECT_TOKEN is required (via the setup code or env) — copy the one-liner from the platform's setup screen.");
    }
    /* A grant is what makes a sandbox reachable from anywhere; it is NOT what makes it run. */
    if let Some(warning) = reachability_warning(&sandbox_hostname, &sandbox_grant, &ingress_url) {
        ui::warn(&warning);
    }
    // SELF_HOST still wants the user's OWN Cloudflare token: it publishes THIS machine's sshd so the sandbox
    // can deploy to it, which is the deploy engine's fabric — not the sandbox's, which the hub now serves.
    if self_host && cf_token.is_empty() {
        bail!("SELF_HOST needs your own Cloudflare API token (CF_TOKEN) — it publishes this machine's SSH for\n       the deploy engine. Create one at https://dash.cloudflare.com/profile/api-tokens with:\n       Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit.");
    }
    if self_host && zone.is_empty() {
        zone = cloudflare::resolve_zone(&cf_token, "this machine")?;
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
        ui::note(&format!(
            "this server is registered as a deploy target (user '{self_host_user}')."
        ));
    }

    // A replace keeps the image the sandbox runs (its environment build included) unless SANDBOX_IMAGE names another,
    // and the resolvers it was made with unless SANDBOX_DNS does.
    if let Some(replacing) = &replacing {
        if let Some(kept) = replacing.kept_image(env("SANDBOX_IMAGE").as_deref()) {
            sandbox_image = kept.to_string();
        }
        if let (None, Some(dns)) = (env("SANDBOX_DNS"), &replacing.dns) {
            sandbox_dns = dns.clone();
        }
    }
    // Resolve the image up front (a slow first pull shouldn't look like a hang) — and the tunnel step below,
    // which runs this same image via `--entrypoint intentic`, must never execute a stale locally-cached tag.
    reporter.stage("pulling-image");
    let keeps_image = replacing.as_ref().is_some_and(|replacing| {
        replacing
            .kept_image(env("SANDBOX_IMAGE").as_deref())
            .is_some()
    });
    if keeps_image && docker::image_exists(&sandbox_image) {
        step(
            "pulling-image",
            &format!("using the image this sandbox runs ({sandbox_image})."),
        );
    } else if keeps_image && is_registryless(&sandbox_image) {
        bail!("the image this sandbox runs ({sandbox_image}) is no longer on this machine, so it cannot be reinstalled as it is. Nothing was changed.\n       Run `ic sandbox update {slug}` first, or name the image to use in SANDBOX_IMAGE.");
    } else if reuses_local_image(env("INTENTIC_REUSE_IMAGE").as_deref(), self_host)
        && docker::image_exists(&sandbox_image)
    {
        step(
            "pulling-image",
            &format!("using the sandbox image already on this machine ({sandbox_image})."),
        );
        // Anything fetched ahead for it is a second copy nothing will read.
        crate::image_cache::discard(&sandbox_image);
    } else {
        // An image fetched ahead of Docker (`ic image prefetch`, which the desktop app starts while Docker is still being
        // installed) is finished and loaded here instead of pulled; without one, or if it cannot be used, the pull.
        match crate::image_cache::load_if_cached(&sandbox_image, &log) {
            crate::image_cache::Cached::Loaded => step(
                "pulling-image",
                &format!("loaded the sandbox image downloaded ahead of time ({sandbox_image})."),
            ),
            crate::image_cache::Cached::Nothing => ensure_image(&sandbox_image, &log)?,
            crate::image_cache::Cached::Failed(why) => {
                crate::ui::warn(&format!(
                    "the sandbox image downloaded ahead of time could not be used ({why}); pulling it instead."
                ));
                ensure_image(&sandbox_image, &log)?;
                crate::image_cache::discard(&sandbox_image);
            }
        }
    }

    /* The address is the platform's answer, not something this flow provisions: the box enables against the hub itself and serves its own share. */
    let sandbox_public_url = if sandbox_hostname.is_empty() {
        String::new()
    } else {
        format!("https://{sandbox_hostname}")
    };

    // Expose THIS machine's sshd over its own tunnel so the sandbox can deploy to it through `cloudflared
    // access` — a NAT'd local machine the sandbox can't reach by IP.
    #[cfg(unix)]
    if self_host {
        step("creating-tunnel", "creating the host SSH tunnel…");
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
        let cloudflared_version = env_or("CLOUDFLARED_VERSION", "2026.10.0");
        crate::selfhost::install_cloudflared(&root, &cloudflared_version)?;
        crate::selfhost::run_ssh_connector(&root, &host_tunnel_token, "the connect one-liner")?;
        ui::note(&format!(
            "this host's SSH is reachable through the tunnel at {self_host_address}."
        ));
    }

    step("starting-sandbox", "starting sandbox…");
    reporter.stage("starting-sandbox");
    // Created first because the container joins it: a Windows self-host target (the dind container above) is
    // reached by name on it, and nothing else on this machine is.
    crate::sandbox::ensure_network(&slug)?;
    // A replace cuts the agents' turns, which are picked up again once the sandbox is back (resume.rs).
    if replacing.is_some() {
        resume::ask(&container);
    }

    // Windows self-host: the Docker-in-Docker deploy target, ALONGSIDE the sandbox on Docker Desktop, not
    // inside it — the control plane stays an unprivileged container outside its (privileged) targets, and it
    // reaches this one over SSH by name on the shared network. The key is generated INSIDE the target.
    #[cfg(windows)]
    if self_host {
        let (key, user, address) = start_dind_target(&slug, &log)?;
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
    let host_label = machine_label();
    let fresh: &[(&str, &str)] = &[
        ("PREVIEW_PORT", &preview_port),
        ("GOOGLE_CLIENT_ID", &google_client_id),
        ("CONNECT_TOKEN", &connect_token),
        ("OWNER_EMAIL", &owner_email),
        // The arriving profile's own sandbox. Empty for everyone who arrived without one, and dropped with the
        // other empties below rather than handed over as a blank the daemon would try to decode.
        ("SANDBOX_DEFINITION_SEED", &definition_seed),
        ("WEB_ORIGIN", &web_origin),
        ("SANDBOX_PUBLIC_URL", &sandbox_public_url),
        ("PLATFORM_URL", &platform_url_container),
        // The whole of reachability, and the reason `connect-env.test.ts` pins this list: the daemon reads
        // these two out of its own environment and dials the edge with them, so a key missing here is a
        // sandbox that boots, comes healthy, registers, and answers 502 on the address it was given.
        ("SANDBOX_GRANT", &sandbox_grant),
        ("INGRESS_URL", &ingress_url),
        ("SYNC_PAIR_TOKEN", &sync_pair_token),
        // Which folder under /work is the owner's own, so the daemon seeds no starter beside it and tells its agents
        // where to work. Replayed, so a recreate, an update or a rollback keeps the sandbox what it was made as.
        (
            "SANDBOX_PROJECT_DIR",
            placement.project_dir.as_deref().unwrap_or(""),
        ),
        // This computer's own sandbox, which folders attach to later: no starter site, and its projects learned from the
        // machine agent's reports. Replayed for the same reason as the folder above.
        ("SANDBOX_PROJECTS_HOST", placement.projects_host_env()),
        // The connected-device seed: the pairing the machine agent below redeems, plus what to call this
        // machine and which OS card it gets. The daemon cannot learn either for itself — it is in a container
        // with its own hostname, on a Linux however this machine is spelled.
        ("HOST_PAIR_TOKEN", &host_pair_token),
        ("HOST_PLATFORM", host_platform()),
        ("HOST_LABEL", &host_label),
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
    ];
    // A replace hands the image this run's pairs AND the old container's whole env: what it carries over wins over
    // this run's defaults, the claim wins over what it carried, and the contract keeps only the names it replays.
    let explicit: Vec<&str> = [
        env("WEB_ORIGIN").map(|_| "WEB_ORIGIN"),
        agent_auth_volume.as_ref().map(|_| "AGENT_AUTH_DIR"),
    ]
    .into_iter()
    .flatten()
    .collect();
    let env_pairs = match &replacing {
        None => crate::util::nul_frame(fresh),
        Some(replacing) => replace_env(fresh, &replacing.env, &explicit),
    };
    let mut mounts: Vec<String> = agent_auth_volume
        .as_ref()
        .or(replacing
            .as_ref()
            .and_then(|replacing| replacing.agent_auth.as_ref()))
        .map(|volume| format!("{volume}:/agent-auth"))
        .into_iter()
        .collect();
    if let Some(replacing) = &replacing {
        mounts.extend(replacing.dev_mounts.iter().cloned());
    }
    let mounts = (!mounts.is_empty()).then(|| mounts.join("\n"));
    // What a kept environment build needs beside its image: the base it extends, its hash, and its runtime directives.
    let kept = replacing.as_ref().filter(|replacing| {
        replacing
            .kept_image(env("SANDBOX_IMAGE").as_deref())
            .is_some()
    });
    let previous_image = replacing
        .as_ref()
        .and_then(|replacing| replacing.record.targets().into_iter().next())
        .map(|pin| pin.image);
    let request = RunRequest {
        image: &sandbox_image,
        slug: &slug,
        base_image: kept
            .and_then(|kept| kept.base_image.as_deref())
            .unwrap_or(&sandbox_image),
        channel: replacing
            .as_ref()
            .and_then(|replacing| replacing.record.channel.as_deref()),
        previous_image: previous_image.as_deref(),
        environment_hash: kept.and_then(|kept| kept.environment_hash.as_deref()),
        runtime: kept
            .map(|kept| kept.runtime_lines.as_str())
            .filter(|lines| !lines.is_empty()),
        mounts: mounts.as_deref(),
        dns: (!sandbox_dns.is_empty()).then_some(sandbox_dns.as_str()),
        // A person's sandbox is set up by its owner in the browser; the seed is the runner/fleet door.
        definition_b64: None,
    };
    // Which runtime asks this host cannot honour, probed through the image as a recreate does: a replace carries the
    // environment's directives and the owner's own (SANDBOX_RUNTIME), and a new sandbox has neither.
    let probes = match &replacing {
        Some(replacing) if request.runtime.is_some() || !replacing.host_runtime.is_empty() => {
            contract::host_probes(
                &sandbox_image,
                request.runtime.unwrap_or_default(),
                &replacing.host_runtime,
                &log,
            )
        }
        _ => Vec::new(),
    };
    let unsupported = contract::unsupported_on_this_host(&probes);
    // What ic adds to the image's run line (labels.rs): its labels, and HOST_ENV. HOST_ENV rides here and not in the
    // pairs above because the run contract replays only the names it lists, and the images already published do not
    // list it (2026-10-05): handed over with the pairs, it would be dropped before the container ever saw it. A replace
    // keeps the side the old container names, as a recreate does.
    let stamped_run = match &replacing {
        None => stamped_run(&slug, &side::here()),
        Some(replacing) => recreate::stamp_args(
            &slug,
            &recreate::restamp(replacing.side.as_ref(), &side::here()),
        ),
    };
    let argv = crate::sandbox::labels::into_run(
        &contract::run_command(&request, &env_pairs, false, &unsupported, &[], &log)?,
        &stamped_run,
    );
    // The old container is set aside only now, with the new run line in hand: it comes back if the new one fails.
    if let Some(replacing) = &replacing {
        replacing.park()?;
    } else {
        docker::quiet(&["rm", "-f", &container]);
    }
    // The volumes are made here, labelled, instead of by `docker run` in passing, and this run remembers which it
    // made: a first setup that fails to start leaves none of them behind (audit 2026-10 item 14), and a re-run's
    // existing volumes, which hold a sandbox's data, are never among them.
    let made = make_volumes(&slug);
    log.section(&format!("docker run {sandbox_image}"));
    // Two attempts: the loopback shortcut (127.0.0.1:<derived port>:8787, a browser on this machine skipping
    // the tunnel) is the one part whose failure doesn't mean a broken sandbox — docker refuses the WHOLE
    // launch when the port is held, so the retry drops just the shortcut.
    if docker::run_argv(&argv, &log).is_err() {
        docker::quiet(&["rm", "-f", &container]);
        // Everything optional comes off together on the retry, as on a recreate's: the loopback shortcut and every
        // runtime directive whose probe passed but whose run may still not.
        let all_optional: Vec<String> = probes.iter().map(|probe| probe.token.clone()).collect();
        let retry =
            match contract::run_command(&request, &env_pairs, true, &all_optional, &[], &log) {
                Ok(retry) => crate::sandbox::labels::into_run(&retry, &stamped_run),
                Err(err) => match &replacing {
                    Some(replacing) => bail!("{}{}", err.0, replacing.put_back(&err.0, &log)),
                    None => return Err(err),
                },
            };
        if let Err(refusal) = docker::run_argv(&retry, &log) {
            let left = match &replacing {
                Some(replacing) => {
                    replacing.put_back(&format!("starting it again failed: {refusal}"), &log)
                }
                None => {
                    docker::quiet(&["rm", "-f", &container]);
                    remove_made(&made)
                }
            };
            bail!(
                "starting the sandbox failed — the full docker error is saved to {}.\n{refusal}{left}",
                log.path.display()
            );
        }
        ui::note("started without the local shortcut (its port is taken) — this browser reaches the sandbox over its tunnel.");
    }

    // No connector container: the sandbox's own entrypoint enables against the hub with the grant below and
    // serves its share from inside. One less container per sandbox, and the token never sits beside the box.

    step(
        "waiting-health",
        "waiting for the sandbox daemon to come up…",
    );
    reporter.stage("waiting-health");
    // The sandbox's report key, kept for a later `ic sandbox fix` that finds Docker down and the env unreadable.
    crate::sandbox::fix::report::remember(&slug, Some(&connect_token), Some(platform_url));
    match &replacing {
        None => {
            health::wait_answering(&container, &log, "")?;
        }
        /* The same gate a recreate holds its new version to, and the same way back: the old container is put back
        unless the new one answers AND commits its state journal. */
        Some(replacing) => {
            let ready = health::wait_answering(&container, &log, "")
                .and_then(|answered| health::wait_ready(&container, &answered));
            if let Err(err) = ready {
                log.section(&format!("container logs ({container})"));
                docker::logs_into(&container, "500", &log);
                bail!("{}{}", err.0, replacing.put_back(&err.0, &log));
            }
            replacing.done();
        }
    }

    /* POSTFLIGHT — a daemon answering INSIDE the container proves only half the chain. */
    step(
        "verifying",
        "verifying the sandbox is reachable end to end…",
    );
    reporter.stage("verifying");
    let findings = doctor::verify_chain(
        &slug,
        if sandbox_public_url.is_empty() {
            None
        } else {
            Some(&sandbox_public_url)
        },
        std::time::Duration::from_secs(120),
    );
    if let Some(summary) = checks::failure_summary(&findings) {
        /* WHOSE VERDICT THIS IS. */
        if setup_code.is_some() {
            reporter.findings_failed("verifying", checks::wire_failures(&findings));
            bail!("{summary}\nThe sandbox itself is running on this machine — fix the above, then re-check with: ic sandbox doctor {slug}");
        }
        ui::warn(&format!("the sandbox is running, but the links above are not reachable from this machine — re-check any time with: ic sandbox doctor {slug}"));
    }

    reporter.stage("done");

    /* Desktop sync chosen at setup: the same paste covers it, gated on the opt-in the command carried (a folder in
    SYNC_DIR, or SYNC_PROJECTS_HOST's folderless pairing). */
    if placement.syncs(sync_dir.is_some())
        && !sync_pair_token.is_empty()
        && !sandbox_public_url.is_empty()
        && !run_desktop_sync(
            &container,
            &sandbox_public_url,
            &sync_pair_token,
            sync_dir.as_deref(),
            &placement,
        )
    {
        ui::warn(sync_unfinished(&placement));
    }

    /* Connect this machine as a device — not gated on an opt-in, unlike sync above, because it needs no decision from the user. */
    let kept_device = replacing
        .as_ref()
        .and_then(|replacing| connected_device(&replacing.env));
    if let Some(label) = &kept_device {
        // Enrolling again would pair a second device for the same machine, one no card grants, and move this machine's
        // link off the device the owner already set up (the machine agent keeps one link per sandbox).
        ui::note(&format!(
            "this device stays connected as {label}; nothing to pair again."
        ));
    } else if !host_pair_token.is_empty()
        && !sandbox_public_url.is_empty()
        && !run_host_agent(&container, &sandbox_public_url, &host_pair_token)
    {
        ui::warn("this device wasn't connected, so its sandboxes won't be manageable from your browser. Add it any time from Capabilities.");
    }

    ending(&slug, &container, &sandbox_public_url, self_host);
    Ok(())
}

/// What connect does about a sandbox this machine already has under the slug the claim names.
#[derive(Debug, PartialEq, Eq)]
enum Existing {
    /// Nothing here by that name: a new sandbox.
    None,
    /// One is here and nobody said to replace it.
    Refuse,
    /// One is here and `--replace` said to reinstall it, keeping what it was set up as.
    Replace,
}

/// A sandbox that exists, parked or not, is reinstalled only on `--replace` or on a person at this machine's terminal
/// answering yes. -y answers the other-sandboxes question, never this one, so a script or the machine agent has to say
/// --replace; no terminal is no. The question comes after the setup code was spent (the slug is only in the claim), so
/// a yes carries on with the claim in hand, where a refusal costs a new code. Pure but for `ask`, called only when a
/// person could answer it.
fn existing(exists: bool, replace: bool, yes: bool, ask: impl FnOnce() -> bool) -> Existing {
    match (exists, replace) {
        (false, _) => Existing::None,
        (true, true) => Existing::Replace,
        (true, false) if !yes && ask() => Existing::Replace,
        (true, false) => Existing::Refuse,
    }
}

/// What a refused connect says: what is here, what connect would have done, and what to run instead. Pure.
fn refusal(slug: &str) -> String {
    format!(
        "sandbox {slug} already exists on this machine, and connect would install it again from scratch. Nothing was changed.\n       To repair it: ic sandbox fix {slug}\n       To go back to the version before: ic sandbox rollback {slug} (or rebuild its environment from the command on its Environment card: ic sandbox rebuild {slug} <hash>)\n       To reinstall it anyway, keeping its files, history, logins, settings and device: run the setup command again with a new code (this one is used up) from a terminal and answer yes, or add --replace."
    )
}

/// The names a replace keeps from the container it replaces over this run's own defaults: what to call this machine and
/// which side made it, the browser origin it answers, the logins volume, and the dev checkout it was launched from.
const CARRIED: [&str; 5] = [
    "HOST_LABEL",
    "HOST_PLATFORM",
    "WEB_ORIGIN",
    "AGENT_AUTH_DIR",
    "SANDBOX_DEV_ROOT",
];

/// The env a replace hands the image, NUL-framed. The contract takes each name's FIRST occurrence and keeps only the
/// names it replays (recreate.rs), so the order is the policy: the CARRIED values (unless this run set one `explicit`ly),
/// then this run's own non-empty pairs, the claim's tokens and the sandbox's identity among them, then everything the
/// old container carried, for whatever this run left empty. One claim key gives way: the device pairing, while the old
/// container's device is kept (`connected_device`), since a fresh pairing nobody redeems would sit armed in the sandbox
/// for a device that is already connected. Pure.
fn replace_env(fresh: &[(&str, &str)], old: &[u8], explicit: &[&str]) -> Vec<u8> {
    let text = String::from_utf8_lossy(old);
    let old_pairs: Vec<(&str, &str)> = text
        .split('\0')
        .filter_map(|pair| pair.split_once('='))
        .collect();
    let old_value = |name: &str| {
        old_pairs
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| *value)
            .filter(|value| !value.is_empty())
    };
    let device = connected_device(old).map(|_| "HOST_PAIR_TOKEN");
    let mut pairs: Vec<(&str, &str)> = CARRIED
        .iter()
        .copied()
        .filter(|name| !explicit.contains(name))
        .chain(device)
        .filter_map(|name| old_value(name).map(|value| (name, value)))
        .collect();
    pairs.extend(fresh.iter().filter(|(_, value)| !value.is_empty()));
    pairs.extend(old_pairs.iter());
    crate::util::nul_frame(&pairs)
}

/// The device the old container's setup connected, by the name it was given: a container carrying both the pairing it
/// armed and the machine's label. A replace enrolls nothing again for it. Pure.
fn connected_device(old: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(old);
    let value = |name: &str| {
        text.split('\0')
            .find_map(|pair| pair.strip_prefix(&format!("{name}=")))
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    value("HOST_PAIR_TOKEN").and(value("HOST_LABEL"))
}

/// The dev wrapper's binds of a checkout's compiled trees over the image's own copies (dev-mounts.mjs): the ones a
/// replace keeps, when the run was not handed its own. Pure.
fn sandbox_binds(binds: &[String]) -> Vec<String> {
    binds
        .iter()
        .filter(|bind| {
            bind.rsplit_once(':')
                .is_some_and(|(_, destination)| destination.starts_with("/opt/sandbox/"))
        })
        .cloned()
        .collect()
}

/// A replace in progress: the sandbox's lock, and everything read off the container it replaces before that container
/// is set aside.
struct Replacing {
    slug: String,
    container: String,
    parked: String,
    _held: lock::Held,
    record: ChannelRecord,
    env: Vec<u8>,
    agent_auth: Option<String>,
    image: Option<String>,
    base_image: Option<String>,
    environment_hash: Option<String>,
    runtime_lines: String,
    host_runtime: String,
    dns: Option<String>,
    dev_mounts: Vec<String>,
    side: Option<Side>,
}

impl Replacing {
    /// Take the sandbox's lock, settle any swap still on its record, and read what the container is.
    fn take(slug: &str, container: &str, parked: &str) -> Result<Replacing> {
        let held = lock::hold_for_person(slug)?;
        // A recreate that died with the sandbox parked left the name empty: the parked container is the sandbox.
        if !docker::container_exists(container) {
            docker::quiet(&["rename", parked, container]);
        }
        crate::record::read(slug)?;
        let record = recreate::supersede_swap(slug, mirror::reconcile(slug))?;
        let env = docker::container_env_nul(container)?;
        let value = |name: &str| {
            String::from_utf8_lossy(&env)
                .split('\0')
                .find_map(|pair| pair.strip_prefix(&format!("{name}=")).map(str::to_string))
                .filter(|value| !value.is_empty())
        };
        let environment_hash = value("SANDBOX_ENVIRONMENT_HASH");
        // The environment's runtime directives, from its recipe, as a reshape reads them for the image it keeps.
        let runtime_lines = if environment_hash.is_some() {
            let dir = tempfile::tempdir()?;
            let path = dir.path().join("overlay.Dockerfile");
            recreate::stage_overlay(container, &path)?;
            recreate::runtime_lines(&std::fs::read_to_string(&path).unwrap_or_default())
        } else {
            String::new()
        };
        let dev_mounts = match recreate::dev_mounts() {
            given if !given.is_empty() => given,
            _ => sandbox_binds(&docker::bind_mounts(container)),
        };
        Ok(Replacing {
            slug: slug.to_string(),
            container: container.to_string(),
            parked: parked.to_string(),
            _held: held,
            record,
            agent_auth: docker::mount_source(container, "/agent-auth"),
            image: value("SANDBOX_IMAGE")
                .or_else(|| docker::inspect(container, "{{.Config.Image}}")),
            base_image: value("SANDBOX_BASE_IMAGE"),
            environment_hash,
            runtime_lines,
            host_runtime: value("SANDBOX_RUNTIME").unwrap_or_default(),
            dns: docker::inspect(container, "{{join .HostConfig.Dns \" \"}}")
                .filter(|servers| !servers.is_empty()),
            dev_mounts,
            side: match side::stamp_in(&env) {
                side::Stamp::Side(side) => Some(side),
                _ => None,
            },
            env,
        })
    }

    /// The image the sandbox runs, kept unless SANDBOX_IMAGE names another.
    fn kept_image(&self, asked: Option<&str>) -> Option<&str> {
        match asked {
            Some(_) => None,
            None => self.image.as_deref(),
        }
    }

    /// Set the old container aside under its parked name, as a recreate's cutover does; any container a swap left
    /// parked is superseded (its record was settled in `take`).
    fn park(&self) -> Result<()> {
        docker::quiet(&["rm", "-f", &self.parked]);
        docker::quiet(&["stop", &self.container]);
        if let Err(refusal) = docker::capture(&["rename", &self.container, &self.parked]) {
            docker::quiet(&["start", &self.container]);
            bail!(
                "the sandbox could not be set aside to be replaced ({}). It was started again as it was, and nothing was replaced.",
                refusal.0
            );
        }
        Ok(())
    }

    /// Put the old container back after a replacement that did not come up; the sentence that ends the failure.
    fn put_back(&self, reason: &str, log: &Log) -> String {
        let swap = Swap {
            phase: Phase::Cutover,
            at: now_ms(),
            verb: "connect".to_string(),
            from: self.image.clone(),
            to: None,
            until: None,
            reach: None,
            strikes: 0,
            daemon_start: None,
            daemon_restarts: 0,
            alive: None,
        };
        match recreate::restore_parked(
            &self.container,
            &self.parked,
            &self.slug,
            &self.record,
            &swap,
            reason,
            log,
        ) {
            Restored::Answering => "\n       Your sandbox was put back as it was and answers again. Nothing was replaced.".to_string(),
            Restored::Down(why) => format!(
                "\n       Your sandbox was put back as it was, but it does not come up either: {why}.\n       `ic sandbox doctor {}` checks every layer between here and it.",
                self.slug
            ),
            Restored::NotPut => String::new(),
        }
    }

    /// The replacement is up: the old container is no longer the way back.
    fn done(&self) {
        docker::quiet(&["rm", "-f", &self.parked]);
    }
}

/// The options ic puts into a new sandbox's run line beside the image's own: its labels, and HOST_ENV when this
/// side's environment is known. Pure.
fn stamped_run(slug: &str, here: &crate::sandbox::side::Side) -> Vec<String> {
    let mut extra =
        crate::sandbox::labels::args(slug, crate::sandbox::labels::Kind::Sandbox, &here.wire());
    if let Some(env) = &here.env {
        extra.extend(["-e".to_string(), format!("HOST_ENV={env}")]);
    }
    extra
}

/// The volumes the run contract mounts, made with ic's labels where they do not exist yet; returns the ones made now.
pub(crate) fn make_volumes(slug: &str) -> Vec<String> {
    use crate::sandbox::labels::{create_volume, Kind};
    [
        (format!("intentic-workspace-{slug}"), Kind::VolumeWorkspace),
        (format!("intentic-history-{slug}"), Kind::VolumeHistory),
        (format!("intentic-docker-{slug}"), Kind::VolumeDocker),
    ]
    .into_iter()
    .filter(|(name, kind)| create_volume(name, slug, *kind))
    .map(|(name, _)| name)
    .collect()
}

/// Remove the volumes this run made, after a launch that never started: they hold nothing yet. Says which could not
/// go, as the tail of the failure message.
pub(crate) fn remove_made(made: &[String]) -> String {
    let left: Vec<&String> = made
        .iter()
        .filter(|volume| !docker::ok(&["volume", "rm", volume.as_str()]))
        .collect();
    if left.is_empty() {
        return String::new();
    }
    format!(
        "\n       These empty volumes this setup made could not be removed: {} (docker volume rm <name>).",
        left.iter()
            .map(|volume| volume.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/* WHAT THIS RUN CAN PROMISE ABOUT REACHABILITY — three states, and the middle one is the reason this is a function rather than a boolean. */
fn reachability_warning(hostname: &str, grant: &str, ingress: &str) -> Option<String> {
    if hostname.is_empty() {
        return Some(
            "no public address — this sandbox will answer on this machine only (loopback).\nRe-open its setup screen for a command that carries one, or publish it behind your own domain."
                .to_string(),
        );
    }
    let missing = match (grant.is_empty(), ingress.is_empty()) {
        (false, false) => return None,
        (true, true) => "no reachability grant and no edge to dial",
        (true, false) => "no reachability grant",
        (false, true) => "no edge to dial",
    };
    Some(format!(
        "{missing} — this sandbox will answer on this machine only, and https://{hostname} will answer 502 for as long as that is true.\nRe-open its setup screen for a fresh command, unless you front that address yourself."
    ))
}

/* THE ENDING, RANKED — because the old one was seven lines of equal weight and the reader had to find the two that mattered among them. */
fn ending(slug: &str, container: &str, public_url: &str, self_host: bool) {
    let mut footnotes: Vec<(String, String)> = vec![
        (
            "its logs".to_string(),
            format!("docker logs -f {container}"),
        ),
        ("stop it".to_string(), format!("docker stop {container}")),
        (
            "reset it".to_string(),
            format!("ic sandbox remove {slug} -y"),
        ),
        (
            "setup log".to_string(),
            crate::logfile::log_dir().display().to_string(),
        ),
    ];
    if !self_host {
        footnotes.push((
            "deploy here".to_string(),
            "re-run with SELF_HOST=1 (needs sudo)".to_string(),
        ));
    }
    if ui::is_rich() {
        let (address, instruction) = if public_url.is_empty() {
            (
                None,
                "Your sandbox answers on this machine only — open it from the platform on this device.",
            )
        } else {
            (
                Some(public_url),
                "Go back to your browser — your sandbox announces itself and setup continues there.",
            )
        };
        ui::finished("Your sandbox is running.", address, instruction, &footnotes);
        return;
    }
    // Piped: the historical prose, in the historical shape. Nothing parses it (desktop.ts reads only the
    // `intentic: [phase]` markers and treats everything else as detail), but it IS what a saved install log
    // has always looked like, and a log that reads differently for no reason is a log people re-learn.
    println!("intentic sandbox started.");
    if public_url.is_empty() {
        println!(
            "Your sandbox answers on this machine only — open it from the platform on this device."
        );
    } else {
        println!("Your sandbox will be reachable at {public_url} (DNS may take a few seconds to propagate).");
        println!(
            "Return to the platform — your sandbox announces itself and setup continues automatically."
        );
    }
    if !self_host {
        println!("Reachable only — no deploy target. To deploy an app onto this machine later, re-run with SELF_HOST=1 (needs sudo).");
    }
    println!(
        "Logs: docker logs -f {container} (connect logs: {})",
        crate::logfile::log_dir().display()
    );
    println!("Stop (keeps your /work): docker stop {container}");
    println!("Reset this sandbox (also removes its /work volume): ic sandbox remove {slug} -y");
}

/// Does this reference carry an explicit registry host? The part before the first `/` counts as one when it
/// looks like a hostname — it contains a `.` or a `:port`, or it is `localhost`. A bare name like
/// `intentic-sandbox:dev` has none (its `:` is the TAG separator, not a port), so docker would resolve it
/// against Docker Hub — which is why such a reference is never pulled: that pull can only ever fail, and its
/// "denied" output is pure noise on top of a dev image that is sitting right there locally.
pub(crate) fn is_registryless(image: &str) -> bool {
    match image.split('/').next() {
        Some(first) if image.contains('/') => {
            !(first.contains('.') || first.contains(':') || first == "localhost")
        }
        _ => true,
    }
}

/// Whether this setup runs the image this machine already holds rather than asking the registry for a newer one:
/// only when its caller asked (`INTENTIC_REUSE_IMAGE=1`, which the desktop app sets on a setup), and never for a
/// self-host setup, whose tunnel step runs the image too. A second sandbox on a machine then skips a registry round
/// trip, and one whose `:stable` moved since the last pull skips gigabytes; the machine agent's update loop keeps
/// that tag current, and the sandbox's own update check offers anything newer, as it does every sandbox running.
fn reuses_local_image(asked: Option<&str>, self_host: bool) -> bool {
    !self_host && asked == Some("1")
}

/// Make the image runnable. A registry-less reference (a dev tag like intentic-sandbox:dev) can only resolve
/// to Docker Hub, so it is never pulled — it runs the local build (the dev wrapper is what rebuilds it from a
/// checkout; this binary ships without one). Registry images are pulled even when cached so the moving
/// `stable` tag always runs the newest release.
pub(crate) fn ensure_image(image: &str, log: &Log) -> Result<()> {
    if is_registryless(image) {
        if docker::image_exists(image) {
            step(
                "pulling-image",
                &format!("using the existing local sandbox image {image}."),
            );
            return Ok(());
        }
        bail!("'{image}' is a local dev tag that isn't built — run 'pnpm build:sandbox' in the intentic repo (or its dev-sandbox wrapper), or unset SANDBOX_IMAGE to use the published image.");
    }
    step(
        "pulling-image",
        &format!("pulling sandbox image {image} (first run can take a minute)…"),
    );
    docker::pull(image, log)
}

/// What a desktop sync that did not finish leaves undone, said in the words of whoever set it up.
fn sync_unfinished(placement: &project_dir::Placement) -> &'static str {
    if placement.projects_host {
        // The folderless pairing is what an attached folder syncs under, so without it no folder can attach.
        "folder sync for this computer's sandbox didn't finish. Your sandbox is fine, but folders can't attach to it until it's set up again from the desktop app."
    } else if placement.project_dir.is_some() {
        // A project folder is synced by the app that picked it: the Desktop sync card would sync /work instead.
        "folder sync didn't finish. Your sandbox is fine; set it up again from the desktop app to sync your folder."
    } else {
        "desktop sync didn't finish. Your sandbox is fine; enable sync any time from the workspace's Desktop sync card."
    }
}

/// Wait for the daemon INSIDE the container (no tunnel/DNS in the loop), then run the standard sync
/// bootstrap — as the INVOKING user when running under sudo: the agent is per-user state (~/.intentic, the
/// user's Mutagen daemon). The sync agent connects over the public URL and retries transient tunnel errors
/// itself, so this local gate need not wait for the tunnel. A projects host passes no folder at all.
fn run_desktop_sync(
    container: &str,
    public_url: &str,
    pair_token: &str,
    sync_dir: Option<&str>,
    placement: &project_dir::Placement,
) -> bool {
    step(
        "desktop-sync",
        "waiting for your sandbox to come online to set up desktop sync…",
    );
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
        &installer_env(public_url, pair_token, sync_dir, placement),
    )
}

/// The sync installer's whole environment: the sandbox and its pairing, the folder when there is one, and the
/// placement's own variables.
fn installer_env<'a>(
    public_url: &'a str,
    pair_token: &'a str,
    sync_dir: Option<&'a str>,
    placement: &'a project_dir::Placement,
) -> Vec<(&'a str, &'a str)> {
    let mut vars = vec![("SANDBOX_URL", public_url), ("PAIR_TOKEN", pair_token)];
    if let Some(dir) = sync_dir {
        vars.push(("SYNC_DIR", dir));
    }
    vars.extend(placement.installer_vars());
    vars
}

/// Connect this machine as a DEVICE, so its sandboxes can be seen and managed from the browser.
///
/// The same bootstrap as desktop sync above and deliberately so — it is the second half of the same promise.
/// Sync makes the machine's FOLDERS reachable from the sandbox; this makes the machine's own fleet reachable,
/// which is the half that used to require a terminal on this exact machine even to restart the sandbox that
/// had wedged.
///
/// What the sandbox may then do here is decided in the sandbox and enforced by the agent this installs: it
/// arrives allowed to start, stop and update this machine's sandboxes and nothing else — no shell, no files,
/// no screen. Widening it is a switch on the device's own card.
fn run_host_agent(container: &str, public_url: &str, pair_token: &str) -> bool {
    step(
        "connecting-machine",
        "connecting this device so you can manage its sandboxes from your browser…",
    );
    if !wait_local_health(container) {
        return false;
    }
    run_agent_bootstrap(
        AgentBootstrap {
            what: "this device",
            url_var: "HOST_SCRIPT_URL",
            unix_url: "https://intentic.dev/device",
            windows_url: "https://intentic.dev/device.ps1",
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
            &["curl", "-fsS", "--max-time", "5", crate::health::HEALTH_URL],
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
    /* These installers inherit stdout, so two things have to be arranged before they get it. */
    let child_vars = agent_env(vars, ui::is_rich());
    ui::suspend();
    let finished = run_agent_script(&url, agent.what, &child_vars);
    ui::resume();
    finished
}

/// The environment a spawned agent installer runs with: its own variables, plus the mode it should render in.
///
/// Pure so the one decision here is tested rather than reasoned about. `nested` is set only when THIS run is
/// drawing a checklist — a piped run hands the child the same pipe, and the child's own `is stdout a terminal`
/// test reaches the right answer without being told (docs/ops/cli-output-protocol.md, "Choosing a mode").
fn agent_env<'a>(vars: &[(&'a str, &'a str)], rich: bool) -> Vec<(&'a str, &'a str)> {
    let mut child = vars.to_vec();
    if rich {
        child.push(("INTENTIC_UI", "nested"));
    }
    child
}

// `what` names the agent in the one refusal only the unix path can reach (root with no invoking user).
#[cfg_attr(windows, allow(unused_variables))]
fn run_agent_script(url: &str, what: &str, vars: &[(&str, &str)]) -> bool {
    #[cfg(unix)]
    {
        // Fetch before piping — a failed fetch must fail the bootstrap, not feed sh half a script.
        let Ok(mut response) = ureq::get(url).call() else {
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
                ui::warn(&format!(
                    "skipping {what} — running as root with no invoking user to install it for."
                ));
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

/// The card this machine gets in the sandbox — one of the OS slugs the bundled devices extension declares.
pub fn host_platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

/// Which environment of this machine this ic runs in, beside the platform above (side.rs): `windows`, the distro's
/// own name inside WSL, `macos` or `linux` elsewhere. Two WSL distros on one PC both say `linux` as their platform,
/// and this is what tells them apart. None inside WSL when the distro is not named (a process WSL did not start
/// itself, a systemd unit): a guessed name could disagree with the one stamped by the same distro's next run and leave
/// its own sandbox to nobody, where no name compares on the platform alone.
pub fn host_env() -> Option<String> {
    env_named(
        cfg!(windows),
        cfg!(target_os = "macos"),
        std::env::var("WSL_DISTRO_NAME").ok(),
        || {
            crate::sandbox::fix::host::inside_wsl(
                &std::fs::read_to_string("/proc/version").unwrap_or_default(),
            )
        },
    )
}

/// The environment's name from what the process can see. Pure apart from `in_wsl`, asked only when it decides.
pub fn env_named(
    windows: bool,
    macos: bool,
    distro: Option<String>,
    in_wsl: impl FnOnce() -> bool,
) -> Option<String> {
    if windows {
        return Some("windows".to_string());
    }
    if macos {
        return Some("macos".to_string());
    }
    if let Some(distro) = distro.map(|name| name.trim().to_string()) {
        if !distro.is_empty() {
            return Some(distro);
        }
    }
    (!in_wsl()).then(|| "linux".to_string())
}

/// What to call this machine in the sandbox's UI, and how the agent will address it ("run the tests on
/// ada-laptop"). The hostname is what a person recognises; the daemon cannot read it for itself, since inside
/// the container the hostname is the container's own.
///
/// Read without a crate for it, because every source here is already one line and a dependency in this binary is
/// a dependency in every setup that runs it. `COMPUTERNAME` is always set on Windows, `/etc/hostname` is the
/// standard file everywhere else, and the command is the fallback for a system that has neither.
pub fn machine_label() -> String {
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
        .unwrap_or_else(|| "this-device".to_string())
}

/// The Windows deploy target: a privileged dind-host container on the shared network. Returns the private
/// key, user and address the sandbox will deploy through.
#[cfg(windows)]
fn start_dind_target(slug: &str, log: &Log) -> Result<(String, String, String)> {
    use crate::sandbox::DIND_PREFIX;
    let dind_container = format!("{DIND_PREFIX}{slug}");
    let network = crate::sandbox::trash::network(slug);
    let dind_image = env_or("DIND_IMAGE", "ghcr.io/intentic/dind-host:latest");
    let dind_volume = format!("intentic-dind-docker-{slug}");
    ui::note("starting the Docker-in-Docker deploy target…");
    docker::quiet(&["rm", "-f", &dind_container]);
    crate::sandbox::labels::create_volume(
        &dind_volume,
        slug,
        crate::sandbox::labels::Kind::VolumeDindDocker,
    );
    let labels = crate::sandbox::labels::here(slug, crate::sandbox::labels::Kind::Dind);
    let mut run: Vec<&str> = vec!["run"];
    run.extend(labels.iter().map(String::as_str));
    let mount = format!("{dind_volume}:/var/lib/docker");
    run.extend_from_slice(&[
        "-d",
        "--privileged",
        "--restart",
        "unless-stopped",
        "--name",
        &dind_container,
        "--network",
        &network,
        "-e",
        "DOCKER_TLS_CERTDIR=",
        "-v",
        &mount,
        "--dns",
        "1.1.1.1",
        "--dns",
        "1.0.0.1",
        &dind_image,
    ]);
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
    ui::note(&format!("deploy target '{dind_container}' is ready (the sandbox reaches it over SSH on the shared network)."));
    Ok((key, "root".to_string(), dind_container))
}

#[cfg(test)]
mod tests {
    use super::*;

    /* A SANDBOX THIS MACHINE ALREADY HAS (2026-10-07). */
    #[test]
    fn an_existing_sandbox_is_refused_without_replace_and_reinstalled_only_with_it() {
        let never = || -> bool { panic!("nobody is asked when the answer is already known") };
        assert_eq!(existing(false, false, false, never), Existing::None);
        assert_eq!(existing(false, true, true, never), Existing::None);
        assert_eq!(existing(true, true, true, never), Existing::Replace);
        assert_eq!(existing(true, true, false, never), Existing::Replace);
        // -y is the machine agent and scripts: it never stands in for this answer, and nobody is asked.
        assert_eq!(existing(true, false, true, never), Existing::Refuse);
        // A person at the terminal decides; no answer (no terminal, an empty line) is no.
        assert_eq!(existing(true, false, false, || true), Existing::Replace);
        assert_eq!(existing(true, false, false, || false), Existing::Refuse);
        let said = refusal("sandbox-abc");
        for part in [
            "already exists on this machine",
            "install it again",
            "Nothing was changed",
            "ic sandbox fix sandbox-abc",
            "ic sandbox rollback sandbox-abc",
            "ic sandbox rebuild sandbox-abc",
            "--replace",
        ] {
            assert!(said.contains(part), "{part} missing from: {said}");
        }
    }

    /// The pairs the contract would keep from a framed env: first occurrence of each name, empties dropped (index.ts
    /// replayableEnv), so a test reads what the container gets.
    fn replayed(framed: &[u8]) -> Vec<(String, String)> {
        let text = String::from_utf8_lossy(framed).to_string();
        let mut seen: Vec<(String, String)> = Vec::new();
        for (name, value) in text.split('\0').filter_map(|pair| pair.split_once('=')) {
            if !seen.iter().any(|(key, _)| key == name) {
                seen.push((name.to_string(), value.to_string()));
            }
        }
        seen.retain(|(_, value)| !value.is_empty());
        seen
    }

    fn value<'a>(pairs: &'a [(String, String)], name: &str) -> Option<&'a str> {
        pairs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn a_replace_keeps_what_the_sandbox_was_set_up_as_and_the_claim_wins_its_own_keys() {
        let old = crate::util::nul_frame(&[
            ("HOST_LABEL", "ada-pc"),
            ("HOST_PLATFORM", "windows"),
            ("WEB_ORIGIN", "http://localhost:5173"),
            ("AGENT_AUTH_DIR", "/agent-auth"),
            ("SANDBOX_DEV_ROOT", "/home/ada/intentic"),
            ("SANDBOX_MEMORY", "8g"),
            ("CONNECT_TOKEN", "old-token"),
            ("SANDBOX_GRANT", "old-grant"),
            ("HOST_PAIR_TOKEN", "old-pair"),
        ]);
        let fresh: &[(&str, &str)] = &[
            ("CONNECT_TOKEN", "claim-token"),
            ("SANDBOX_GRANT", "claim-grant"),
            ("WEB_ORIGIN", "https://app.intentic.dev"),
            ("HOST_LABEL", "wsl-box"),
            ("HOST_PLATFORM", "linux"),
            ("HOST_PAIR_TOKEN", "claim-pair"),
            ("AGENT_AUTH_DIR", ""),
            ("OWNER_EMAIL", ""),
        ];
        let pairs = replayed(&replace_env(fresh, &old, &[]));
        // Carried over this run's defaults: the device's name and side, the origin, the logins volume, the checkout.
        assert_eq!(value(&pairs, "HOST_LABEL"), Some("ada-pc"));
        assert_eq!(value(&pairs, "HOST_PLATFORM"), Some("windows"));
        assert_eq!(value(&pairs, "WEB_ORIGIN"), Some("http://localhost:5173"));
        assert_eq!(value(&pairs, "AGENT_AUTH_DIR"), Some("/agent-auth"));
        assert_eq!(
            value(&pairs, "SANDBOX_DEV_ROOT"),
            Some("/home/ada/intentic")
        );
        // The claim's own keys win over what the container carried.
        assert_eq!(value(&pairs, "CONNECT_TOKEN"), Some("claim-token"));
        assert_eq!(value(&pairs, "SANDBOX_GRANT"), Some("claim-grant"));
        // The device stays the one it was: its pairing, not a fresh one nobody will redeem.
        assert_eq!(value(&pairs, "HOST_PAIR_TOKEN"), Some("old-pair"));
        // Whatever this run left empty, the container's own value fills.
        assert_eq!(value(&pairs, "SANDBOX_MEMORY"), Some("8g"));
        assert_eq!(connected_device(&old).as_deref(), Some("ada-pc"));
    }

    #[test]
    fn a_value_this_run_was_given_on_purpose_wins_over_the_carried_one_and_an_unpaired_sandbox_takes_the_claims_pairing(
    ) {
        let old = crate::util::nul_frame(&[
            ("WEB_ORIGIN", "http://localhost:5173"),
            ("AGENT_AUTH_DIR", "/agent-auth"),
            ("HOST_LABEL", "ada-pc"),
        ]);
        let fresh: &[(&str, &str)] = &[
            ("WEB_ORIGIN", "https://staging.intentic.dev"),
            ("AGENT_AUTH_DIR", "/agent-auth"),
            ("HOST_PAIR_TOKEN", "claim-pair"),
        ];
        let pairs = replayed(&replace_env(fresh, &old, &["WEB_ORIGIN"]));
        assert_eq!(
            value(&pairs, "WEB_ORIGIN"),
            Some("https://staging.intentic.dev")
        );
        // No device was ever paired from that container: the claim's pairing is the one to redeem.
        assert_eq!(connected_device(&old), None);
        assert_eq!(value(&pairs, "HOST_PAIR_TOKEN"), Some("claim-pair"));
    }

    #[test]
    fn a_replace_keeps_only_the_dev_checkouts_binds_over_the_image() {
        let binds = vec![
            "/home/ada/intentic/_sandbox/sandbox/dist:/opt/sandbox/dist".to_string(),
            "/var/run/docker.sock:/var/run/docker.sock".to_string(),
            "C:\\Users\\ada\\intentic\\dist:/opt/sandbox/node_modules/@intentic/x/dist".to_string(),
        ];
        assert_eq!(
            sandbox_binds(&binds),
            vec![binds[0].clone(), binds[2].clone()]
        );
    }

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
    fn the_local_image_is_reused_only_when_the_caller_asked_and_nothing_else_runs_it() {
        // The desktop app's setup: the copy this machine holds starts the sandbox, with no registry in the loop.
        assert!(reuses_local_image(Some("1"), false));
        // Anyone else (the one-liner, a script that set nothing) keeps asking the registry for the newest release.
        assert!(!reuses_local_image(None, false));
        assert!(!reuses_local_image(Some("0"), false));
        assert!(!reuses_local_image(Some("yes"), false));
        // A self-host setup's tunnel step runs this image too, and must never run a stale copy of it.
        assert!(!reuses_local_image(Some("1"), true));
    }

    #[test]
    fn a_spawned_agent_is_told_it_is_running_inside_this_checklist() {
        let vars = [("SANDBOX_URL", "https://x.test"), ("PAIR_TOKEN", "tok")];
        // Drawing a checklist: the child must NOT open a second banner in the middle of it. Without this the
        // agents render their own header, plan and ending inside somebody else's install.
        let nested = agent_env(&vars, true);
        assert_eq!(nested.len(), 3);
        assert_eq!(nested[2], ("INTENTIC_UI", "nested"));
        // Piped: the child inherits the same pipe and decides for itself. Forcing a mode here would only be a
        // second place for the two to disagree.
        let piped = agent_env(&vars, false);
        assert_eq!(piped.len(), 2);
        assert!(piped.iter().all(|(name, _)| *name != "INTENTIC_UI"));
        // The agent's own variables ride through untouched either way — they are what it is being run FOR.
        assert_eq!(&nested[..2], &vars[..]);
    }

    /* THE STATE THAT SHIPPED: a claim that named an address and carried no grant. */
    #[test]
    fn an_address_without_a_grant_is_named_rather_than_read_as_reachable() {
        let named = |grant, ingress| {
            reachability_warning("sandbox-abc123.sbx.intentic.dev", grant, ingress)
                .expect("an address this box cannot serve must be named")
        };
        assert!(named("", "https://ingress.sbx.intentic.dev").contains("no reachability grant"));
        assert!(named("ig1.grant", "").contains("no edge to dial"));
        let neither = named("", "");
        assert!(neither.contains("no reachability grant and no edge"));
        // The address is in the sentence: it is the thing that will answer 502, and the reader is about to
        // meet it in the postflight below.
        assert!(neither.contains("sandbox-abc123.sbx.intentic.dev"));

        // Fully equipped: nothing to say. A warning here would be on every ordinary install.
        assert_eq!(
            reachability_warning(
                "sandbox-abc123.sbx.intentic.dev",
                "ig1.grant",
                "https://ingress.sbx.intentic.dev"
            ),
            None
        );
        // No address at all is a posture, not a defect — and it says so in its own words.
        assert!(reachability_warning("", "", "")
            .expect("a loopback-only sandbox is still worth a word")
            .contains("loopback"));
    }

    #[test]
    fn a_projects_host_runs_the_sync_installer_with_no_folder() {
        let host = project_dir::projects_host(None, false, false).unwrap();
        assert_eq!(
            installer_env("https://x.test", "tok", None, &host),
            vec![
                ("SANDBOX_URL", "https://x.test"),
                ("PAIR_TOKEN", "tok"),
                ("SYNC_PROJECTS_HOST", "1"),
            ]
        );
        // A folder's own setup still hands its folder over, and the project flags after it.
        let project = project_dir::placement(Some("/work/my-app"), true, true).unwrap();
        assert_eq!(
            installer_env("https://x.test", "tok", Some("/home/ada/my-app"), &project),
            vec![
                ("SANDBOX_URL", "https://x.test"),
                ("PAIR_TOKEN", "tok"),
                ("SYNC_DIR", "/home/ada/my-app"),
                ("SYNC_REMOTE_DIR", "/work/my-app"),
                ("SYNC_PROJECT", "1"),
            ]
        );
    }

    #[test]
    fn an_unfinished_sync_names_what_it_leaves_undone_for_each_shape() {
        let host = project_dir::projects_host(None, false, false).unwrap();
        assert!(
            sync_unfinished(&host).contains("folders can't attach to it until it's set up again")
        );
        let project = project_dir::placement(Some("/work/my-app"), true, true).unwrap();
        assert!(sync_unfinished(&project).contains("to sync your folder"));
        let workspace = project_dir::placement(None, false, true).unwrap();
        assert!(sync_unfinished(&workspace).contains("Desktop sync card"));
    }

    #[test]
    fn a_new_sandbox_carries_ic_labels_and_its_environment_beside_the_contracts_line() {
        use crate::sandbox::side::Side;
        let extra = stamped_run("sandbox-abc", &Side::new("linux", Some("archlinux")));
        assert!(extra.contains(&"dev.intentic.sandbox=sandbox-abc".to_string()));
        assert!(extra.contains(&"dev.intentic.kind=sandbox".to_string()));
        assert!(extra.contains(&"dev.intentic.side=linux/archlinux".to_string()));
        assert_eq!(&extra[extra.len() - 2..], ["-e", "HOST_ENV=archlinux"]);
        // An environment that is not known is not guessed at.
        let unknown = stamped_run("x", &Side::new("linux", None));
        assert!(!unknown.iter().any(|arg| arg.starts_with("HOST_ENV")));
    }

    #[test]
    fn the_environment_names_the_distro_inside_wsl_and_nothing_it_cannot_know() {
        assert_eq!(
            env_named(true, false, None, || false).as_deref(),
            Some("windows")
        );
        assert_eq!(
            env_named(false, true, None, || false).as_deref(),
            Some("macos")
        );
        assert_eq!(
            env_named(false, false, Some("archlinux".into()), || true).as_deref(),
            Some("archlinux")
        );
        assert_eq!(
            env_named(false, false, None, || false).as_deref(),
            Some("linux")
        );
        // Inside WSL without its name: unknown, so the platform alone is compared, never a guess.
        assert_eq!(env_named(false, false, None, || true), None);
        assert_eq!(env_named(false, false, Some(" ".into()), || true), None);
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
