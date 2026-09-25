mod checks;
mod cloudflare;
mod contract;
mod docker;
mod health;
mod logfile;
#[cfg(unix)]
mod machine;
mod platform;
mod prepare;
mod record;
mod runner;
mod sandbox;
#[cfg(unix)]
mod selfhost;
mod shape;
mod tty;
mod ui;
mod util;

use clap::{ArgGroup, Parser, Subcommand, ValueEnum};

/* ic — intentic's host-side CLI: the flows that must run on the machine that runs the sandbox. */

/// What this binary reports it is. `IC_VERSION` is set by build-ic.sh at release; without it the crate's own
/// `0.0.0` sentinel stands, which is what an unreleased build should say — `Cargo.toml` is never bumped, so a
/// release that stops passing it says 0.0.0 forever rather than a wrong number.
pub const VERSION: &str = match option_env!("IC_VERSION") {
    Some(stamped) => stamped,
    None => env!("CARGO_PKG_VERSION"),
};

#[derive(Parser)]
#[command(
    name = "ic",
    version = VERSION,
    about = "intentic on this machine — sandboxes and deploy targets",
    disable_help_subcommand = true
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// The sandbox containers on this machine
    #[command(subcommand)]
    Sandbox(SandboxCommand),
    /// This machine as a deploy target for a sandbox
    #[command(subcommand)]
    Machine(DeviceCommand),
    /// Runners on this machine — execution containers a parent sandbox dispatches turns to
    #[command(subcommand)]
    Runner(RunnerCommand),
    /// Docker on this machine — what it needs, and getting it there
    #[command(subcommand)]
    Docker(DockerCommand),
}

#[derive(Subcommand)]
enum DockerCommand {
    /// Check every prerequisite for running a sandbox here and, with consent, put them right
    Prepare {
        /// Go ahead without asking (the shims and the desktop app pass this; INSTALL_DOCKER=1 also works)
        #[arg(short = 'y', long = "yes", alias = "force")]
        yes: bool,
        /// Report what is wrong and change nothing
        #[arg(long = "dry-run")]
        dry_run: bool,
    },
}

#[derive(Subcommand)]
enum SandboxCommand {
    /// Run a sandbox on this machine and expose it to your browser (the setup one-liner's flow)
    Connect {
        /// The short-lived code from the platform's setup screen (or SETUP_CODE / CONNECT_TOKEN env)
        #[arg(env = "SETUP_CODE")]
        setup_code: Option<String>,
        /// Start without prompting even if other sandboxes are already running
        #[arg(short = 'y', long = "yes", alias = "force")]
        yes: bool,
    },
    /// Update onto the newest image of this sandbox's release channel, re-applying the approved overlay
    Update {
        /// The sandbox to update (omit when this machine runs exactly one)
        slug: Option<String>,
        /// Move onto a release channel and stay there (e.g. stable)
        #[arg(long)]
        channel: Option<String>,
        /// Update a sandbox built from a checkout anyway, leaving its locally-built image behind — the
        /// published image replaces it, and only a rebuild from that checkout brings it back
        #[arg(long)]
        force: bool,
        /// Swap without first running the target image's state conversions against read-only mounts of
        /// /work and /history — the pre-flight that refuses a swap whose conversions would fail
        #[arg(long = "skip-preflight")]
        skip_preflight: bool,
    },
    /// Download and build the next update WITHOUT applying it, so the update itself is a short restart
    Prepare {
        /// The sandbox to prepare an update for (omit when this machine runs exactly one)
        slug: Option<String>,
        /// Prepare a release channel other than the one this sandbox follows — preparing does NOT move it
        #[arg(long)]
        channel: Option<String>,
        /// Unattended mode (the machine agent's background tick): skip sandboxes a background download
        /// must not track (pinned or locally-built images), treat low disk as "not now" rather than
        /// proceeding, and never un-park a half-finished recreate
        #[arg(long)]
        auto: bool,
    },
    /// Rebuild the owner-approved environment overlay (the Environment card's flow)
    Rebuild {
        /// The sandbox whose overlay was approved
        slug: String,
        /// sha256 of the approved overlay — the trust anchor: only content that still hashes to what the
        /// owner reviewed is ever built
        hash: String,
        /// Swap without first running the target image's state conversions against read-only mounts of
        /// /work and /history — the pre-flight that refuses a swap whose conversions would fail
        #[arg(long = "skip-preflight")]
        skip_preflight: bool,
    },
    /// Back to the image this sandbox ran before its last update
    Rollback {
        /// The sandbox to roll back (omit when this machine runs exactly one)
        slug: Option<String>,
        /// Swap without first running the target image's state conversions against read-only mounts of
        /// /work and /history — the pre-flight that refuses a swap whose conversions would fail
        #[arg(long = "skip-preflight")]
        skip_preflight: bool,
    },
    /// Swap onto the locally-built intentic-sandbox:dev image (the dogfood loop)
    Dev {
        /// The sandbox to swap (omit when this machine runs exactly one)
        slug: Option<String>,
        /// Swap without first running the target image's state conversions against read-only mounts of
        /// /work and /history — the pre-flight that refuses a swap whose conversions would fail
        #[arg(long = "skip-preflight")]
        skip_preflight: bool,
    },
    /// Change a sandbox's share of this machine, or its privileges — a restart of about a minute onto the
    /// same image. The values live on the container and survive every later update, rollback and rebuild.
    /// With no ask at all, the shape saved for the next restart is applied now. `--later` and `--forget` are
    /// the older spellings of `ic sandbox shape … --when next-restart` and `ic sandbox shape --forget`.
    #[command(group = ArgGroup::new("ask").multiple(true))]
    Reshape {
        /// The sandbox to reshape (always named: this changes a container's privileges)
        slug: String,
        /// Memory cap in whole GiB, e.g. 12g — or `default` for the share derived from this machine
        #[arg(long, group = "ask")]
        memory: Option<String>,
        /// CPU cap in whole cores, e.g. 4 — or `default` for every core the engine has
        #[arg(long, group = "ask")]
        cpus: Option<String>,
        /// Run the container privileged (on/off). Withdraws only the owner's own ask: a privilege the
        /// approved environment demands (the Docker capability's) stays in force
        #[arg(long, value_enum, group = "ask")]
        privileged: Option<Switch>,
        /// Pass this machine's NVIDIA GPUs through (on/off); dropped, with a note, on a host without the runtime
        #[arg(long, value_enum, group = "ask")]
        gpus: Option<Switch>,
        /// Save the ask, laid over what runs, for the sandbox's next restart through ic instead of restarting it
        /// now (the older spelling of `shape --when next-restart`, kept for machine agents that send it)
        #[arg(long, requires = "ask", conflicts_with = "forget")]
        later: bool,
        /// Drop the shape saved for the next restart, leaving the sandbox as it runs (`shape --forget`)
        #[arg(long, conflicts_with = "ask")]
        forget: bool,
        /// Swap without first running the target image's state conversions against read-only mounts of
        /// /work and /history — the pre-flight that refuses a swap whose conversions would fail. Only for a
        /// restart: --later and --forget restart nothing
        #[arg(long = "skip-preflight", conflicts_with_all = ["later", "forget"])]
        skip_preflight: bool,
    },
    /// Set a sandbox's shape — its share of this machine and its privileges — now, or for its next restart.
    /// Fields left out keep what is saved for the next restart, else what runs. A shape saved for later is
    /// checked against the image's run contract first, and applied by the next restart through ic: `start`,
    /// `restart`, an update, a rollback or a rebuild (not by Docker restarting the container by itself).
    #[command(group = ArgGroup::new("fields").multiple(true))]
    #[command(group = ArgGroup::new("timing").required(true).args(["when", "forget"]))]
    Shape {
        /// The sandbox to shape (always named: this changes a container's privileges)
        slug: String,
        /// Memory cap in whole GiB, e.g. 12g — or `default` for the share derived from this machine
        #[arg(long, group = "fields")]
        memory: Option<String>,
        /// CPU cap in whole cores, e.g. 4 — or `default` for every core the engine has
        #[arg(long, group = "fields")]
        cpus: Option<String>,
        /// Run the container privileged (on/off); a privilege the approved environment demands stays in force
        #[arg(long, value_enum, group = "fields")]
        privileged: Option<Switch>,
        /// Pass this machine's NVIDIA GPUs through (on/off); dropped, with a note, on a host without the runtime
        #[arg(long, value_enum, group = "fields")]
        gpus: Option<Switch>,
        /// `now` restarts onto the shape; `next-restart` saves it and restarts nothing
        #[arg(long, value_enum, requires = "fields")]
        when: Option<When>,
        /// Drop the shape saved for the next restart
        #[arg(long, conflicts_with = "fields")]
        forget: bool,
        /// Restart without the state-conversion pre-flight. Only with `--when now`
        #[arg(long = "skip-preflight", conflicts_with = "forget")]
        skip_preflight: bool,
    },
    /// Start a stopped sandbox and its tunnel, applying the shape saved for its next restart if there is one
    Start {
        /// The sandbox to start (omit when this machine runs exactly one)
        slug: Option<String>,
    },
    /// Stop a sandbox and its tunnel; its data and anything saved for its next restart are kept
    Stop {
        /// The sandbox to stop (omit when this machine runs exactly one)
        slug: Option<String>,
    },
    /// Restart a sandbox and its tunnel, applying the shape saved for its next restart if there is one
    Restart {
        /// The sandbox to restart (omit when this machine runs exactly one)
        slug: Option<String>,
    },
    /// Check every link of a sandbox's reachability chain and name what is broken, with its fix (read-only)
    Doctor {
        /// The sandbox to diagnose (omit when this machine runs exactly one)
        slug: Option<String>,
    },
    /// List the sandboxes on this machine
    List {
        /// One line of JSON: each sandbox's state, its share as docker enforces it, the shape it runs with, the
        /// shape saved for its next restart and the update staged for it (what the desktop app and the machine
        /// agent read)
        #[arg(long)]
        json: bool,
    },
    /// Remove sandboxes — asks which, confirms; their data stays recoverable for a week
    Remove {
        /// Which sandboxes to remove; none = pick interactively
        slugs: Vec<String>,
        /// Remove EVERY sandbox on this machine
        #[arg(short = 'a', long)]
        all: bool,
        /// Skip confirmation prompts (scripts/CI)
        #[arg(short = 'y', long = "yes", alias = "force")]
        yes: bool,
        /// Also remove the shared dev agent-auth volume (AI logins for ALL dev sandboxes)
        #[arg(long = "agent-auth")]
        agent_auth: bool,
        /// Delete the data now instead of keeping it recoverable for a week
        #[arg(long)]
        now: bool,
    },
    /// Bring a removed sandbox back, with its /work and /history as they were
    Restore {
        /// The sandbox to bring back (omit to pick from what is recoverable)
        slug: Option<String>,
        /// Skip confirmation prompts (scripts/CI)
        #[arg(short = 'y', long = "yes")]
        yes: bool,
    },
    /// Delete a removed sandbox's data now, before its recovery window runs out
    Purge {
        /// Which removed sandboxes to delete; none = pick with --all
        slugs: Vec<String>,
        /// Delete everything in the trash
        #[arg(short = 'a', long)]
        all: bool,
        /// Skip confirmation prompts (scripts/CI)
        #[arg(short = 'y', long = "yes")]
        yes: bool,
    },
}

/// A two-state flag spelled out (`--privileged on`), because a bare `--privileged` could only ever ADD: the
/// same verb has to be able to withdraw the ask, and `--no-privileged` is a spelling nobody guesses.
#[derive(Clone, Copy, PartialEq, Debug, ValueEnum)]
enum Switch {
    On,
    Off,
}

/// When `ic sandbox shape` takes effect.
#[derive(Clone, Copy, PartialEq, Debug, ValueEnum)]
enum When {
    Now,
    NextRestart,
}

/// The verb's `default` is a person's word for the contract's empty value ("clear this, back to what you
/// derive"); every other spelling is forwarded as typed, because what a valid cap is belongs to the contract.
fn seed_value(given: Option<String>) -> Option<String> {
    given.map(|value| {
        if value.trim() == "default" {
            String::new()
        } else {
            value
        }
    })
}

/// The four optional fields as the ask both shape verbs take.
fn ask_of(
    memory: Option<String>,
    cpus: Option<String>,
    privileged: Option<Switch>,
    gpus: Option<Switch>,
) -> shape::Ask {
    shape::Ask {
        memory: seed_value(memory),
        cpus: seed_value(cpus),
        privileged: privileged.map(|switch| switch == Switch::On),
        gpus: gpus.map(|switch| switch == Switch::On),
    }
}

/// `--skip-preflight` as the swap flow reads it.
fn preflight(skip: bool) -> sandbox::recreate::Preflight {
    if skip {
        sandbox::recreate::Preflight::Skip
    } else {
        sandbox::recreate::Preflight::Run
    }
}

// The runner verb surface (runner.rs says what each will do; all refuse until Phase 1 lands). Spellings are
// final: the host agent and the platform's cards will build command lines against them, so they are guarded
// by the same surface test as every other verb from the first commit.
#[derive(Subcommand)]
enum RunnerCommand {
    /// Create a runner here and point it at its parent sandbox (same run contract as `sandbox connect`,
    /// runner env instead of a setup code, no tunnel container)
    Up {
        /// The parent sandbox's public URL — where the runner dials in
        parent_url: String,
        /// The single-use pairing the parent minted (or RUNNER_PAIR_TOKEN env)
        #[arg(long = "pair", env = "RUNNER_PAIR_TOKEN")]
        pair_token: String,
        /// A name for the runner (defaults to a generated one)
        #[arg(long)]
        name: Option<String>,
        /// A settings-only sandbox definition (sandbox.toml) the runner's daemon seeds itself from on first
        /// boot — how the parent's agent settings arrive without an owner in the loop
        #[arg(long = "definition-file")]
        definition_file: Option<String>,
        /// The parent's approved environment overlay (a Dockerfile), built here before boot so the runner
        /// starts as the parent's twin; requires --environment-hash
        #[arg(long = "overlay-file")]
        overlay_file: Option<String>,
        /// The sha256 pinning the overlay to the bytes the parent's owner approved — only content that still
        /// hashes to it is ever built (the `ic sandbox rebuild` rule)
        #[arg(long = "environment-hash")]
        environment_hash: Option<String>,
    },
    /// List the runners on this machine
    List,
    /// Remove a runner: container and volumes — its work lives in the parent's git, so nothing user-owned dies
    Remove {
        /// The runner to remove
        name: String,
        /// Skip the confirmation (headless runs)
        #[arg(short = 'y', long = "yes")]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum DeviceCommand {
    /// Enroll this machine as a deploy target for an existing sandbox (the Infra screen's one-liner)
    Enroll,
    /// Remove everything intentic put on this deploy target — stacks, volumes, state, tunnel, service user
    Remove {
        /// Skip the confirmation (headless runs; CONFIRM=1 works too)
        #[arg(short = 'y', long = "yes")]
        yes: bool,
        /// Leave the service user + its home (and SSH keys) in place
        #[arg(long = "keep-user")]
        keep_user: bool,
    },
}

fn main() {
    #[cfg(windows)]
    docker::adopt_program_folder();
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Sandbox(command) => match command {
            SandboxCommand::Connect { setup_code, yes } => {
                sandbox::connect::run(sandbox::connect::Args { setup_code, yes })
            }
            SandboxCommand::Update {
                slug,
                channel,
                force,
                skip_preflight,
            } => sandbox::recreate::run(
                sandbox::recreate::Mode::Update { channel, force },
                slug,
                preflight(skip_preflight),
            ),
            SandboxCommand::Prepare {
                slug,
                channel,
                auto,
            } => sandbox::recreate::prepare(slug, channel, auto),
            SandboxCommand::Rebuild {
                slug,
                hash,
                skip_preflight,
            } => sandbox::recreate::run(
                sandbox::recreate::Mode::Rebuild { hash },
                Some(slug),
                preflight(skip_preflight),
            ),
            SandboxCommand::Rollback {
                slug,
                skip_preflight,
            } => sandbox::recreate::run(
                sandbox::recreate::Mode::Rollback,
                slug,
                preflight(skip_preflight),
            ),
            SandboxCommand::Dev {
                slug,
                skip_preflight,
            } => sandbox::recreate::run(
                sandbox::recreate::Mode::Dev,
                slug,
                preflight(skip_preflight),
            ),
            SandboxCommand::Reshape {
                slug,
                memory,
                cpus,
                privileged,
                gpus,
                later,
                forget,
                skip_preflight,
            } => {
                let ask = ask_of(memory, cpus, privileged, gpus);
                if forget {
                    sandbox::desired::forget(slug)
                } else if later {
                    sandbox::desired::save_later(slug, ask)
                } else {
                    sandbox::recreate::reshape(slug, ask, preflight(skip_preflight))
                }
            }
            SandboxCommand::Shape {
                slug,
                memory,
                cpus,
                privileged,
                gpus,
                when,
                forget,
                skip_preflight,
            } => match (forget, when) {
                (true, _) | (false, None) => sandbox::desired::forget(slug),
                (false, Some(when)) => sandbox::desired::set(
                    slug,
                    ask_of(memory, cpus, privileged, gpus),
                    match when {
                        When::Now => sandbox::desired::When::Now,
                        When::NextRestart => sandbox::desired::When::NextRestart,
                    },
                    preflight(skip_preflight),
                ),
            },
            SandboxCommand::Start { slug } => {
                sandbox::power::run(sandbox::power::Power::Start, slug)
            }
            SandboxCommand::Stop { slug } => sandbox::power::run(sandbox::power::Power::Stop, slug),
            SandboxCommand::Restart { slug } => {
                sandbox::power::run(sandbox::power::Power::Restart, slug)
            }
            SandboxCommand::Doctor { slug } => sandbox::doctor::run(slug),
            SandboxCommand::List { json: false } => sandbox::list(),
            SandboxCommand::List { json: true } => sandbox::listing::list_json(),
            SandboxCommand::Remove {
                slugs,
                all,
                yes,
                agent_auth,
                now,
            } => sandbox::remove::run(sandbox::remove::Args {
                slugs,
                all,
                yes,
                agent_auth,
                now,
            }),
            SandboxCommand::Restore { slug, yes } => {
                sandbox::restore::run(sandbox::restore::Args { slug, yes })
            }
            SandboxCommand::Purge { slugs, all, yes } => {
                sandbox::restore::purge(sandbox::restore::PurgeArgs { slugs, all, yes })
            }
        },
        Command::Machine(command) => run_machine(command),
        Command::Runner(command) => match command {
            RunnerCommand::Up {
                parent_url,
                pair_token,
                name,
                definition_file,
                overlay_file,
                environment_hash,
            } => runner::up(runner::Up {
                parent_url,
                pair_token,
                name,
                definition_file,
                overlay_file,
                environment_hash,
            }),
            RunnerCommand::List => runner::list(),
            RunnerCommand::Remove { name, yes } => runner::remove(name, yes),
        },
        Command::Docker(DockerCommand::Prepare { yes, dry_run }) => prepare::run(prepare::Args {
            // The desktop app has no terminal to answer a question on, so its consent arrives as the same
            // environment variable connect.sh has always used for a headless install.
            yes: yes || std::env::var("INSTALL_DOCKER").as_deref() == Ok("1"),
            dry_run,
        }),
    };
    if let Err(util::Fail(message)) = result {
        ui::error(&message);
        std::process::exit(1);
    }
}

#[cfg(unix)]
fn run_machine(command: DeviceCommand) -> util::Result<()> {
    match command {
        DeviceCommand::Enroll => machine::enroll::run(),
        DeviceCommand::Remove { yes, keep_user } => {
            machine::remove::run(machine::remove::Args { yes, keep_user })
        }
    }
}

/// Windows can't be a native SSH+Docker deploy target — its stand-in is the Docker-in-Docker container
/// `ic sandbox connect` starts with SELF_HOST=1, not an enrolment of the machine itself.
#[cfg(windows)]
fn run_machine(_command: DeviceCommand) -> util::Result<()> {
    Err(util::Fail(
        "machine enrolment connects Linux servers. On Windows, deploy locally instead: re-run the sandbox setup with $env:SELF_HOST='1', which stands up a Docker-in-Docker deploy target beside the sandbox.".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    /* THE ARGUMENT SURFACE, asserted — the shims and the platform's cards build command lines against it. */

    #[test]
    fn the_command_tree_is_internally_consistent() {
        // clap's own audit: duplicate flags, conflicting shorts, bad arg definitions. It panics on a defect
        // that would otherwise only appear when a user typed the offending combination.
        Cli::command().debug_assert();
    }

    fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
        Cli::try_parse_from(std::iter::once("ic").chain(args.iter().copied()))
    }

    #[test]
    fn rebuild_requires_both_the_slug_and_the_hash() {
        // The hash is the TRUST ANCHOR: the overlay lives on a volume the agent can write, so only content
        // that still hashes to what the owner reviewed may be built. Optional would defeat the whole check.
        let Ok(Cli {
            command:
                Command::Sandbox(SandboxCommand::Rebuild {
                    slug,
                    hash,
                    skip_preflight: false,
                }),
        }) = parse(&["sandbox", "rebuild", "abc123", "deadbeef"])
        else {
            panic!("rebuild did not parse")
        };
        assert_eq!((slug.as_str(), hash.as_str()), ("abc123", "deadbeef"));
        assert!(
            parse(&["sandbox", "rebuild", "abc123"]).is_err(),
            "a hashless rebuild must be refused"
        );
        assert!(parse(&["sandbox", "rebuild"]).is_err());
    }

    #[test]
    fn preparing_takes_the_same_shape_as_updating_because_it_is_the_same_flow_stopped_early() {
        // The card and the connected-device agent build `prepare` and `update` command lines from one
        // place; an argument that binds differently between them would download for one channel and swap
        // onto another.
        let Ok(Cli {
            command:
                Command::Sandbox(SandboxCommand::Prepare {
                    slug,
                    channel,
                    auto,
                }),
        }) = parse(&["sandbox", "prepare", "abc123", "--channel", "beta"])
        else {
            panic!("prepare did not parse")
        };
        assert_eq!(slug.as_deref(), Some("abc123"));
        assert_eq!(channel.as_deref(), Some("beta"));
        assert!(!auto, "a hand-typed prepare must not be unattended");
        assert!(parse(&["sandbox", "prepare", "abc123", "--channel"]).is_err());
        assert!(parse(&["sandbox", "prepare", "extra", "extra2"]).is_err());
    }

    #[test]
    fn auto_is_a_bare_flag_on_prepare_and_nowhere_else() {
        // The machine agent's background tick builds this exact command line (@intentic/machine's
        // auto-prepare). `--auto` softens refusals into skips, so a verb that ACCEPTED it while ignoring it
        // would run unattended with the attended flow's behaviour — worse than a parse error.
        let Ok(Cli {
            command: Command::Sandbox(SandboxCommand::Prepare { slug, auto, .. }),
        }) = parse(&["sandbox", "prepare", "abc123", "--auto"])
        else {
            panic!("prepare --auto did not parse")
        };
        assert_eq!(slug.as_deref(), Some("abc123"));
        assert!(auto);
        assert!(parse(&["sandbox", "update", "abc123", "--auto"]).is_err());
        // A bare flag must not swallow the slug beside it: flag-first is how a generated argv often lands.
        let Ok(Cli {
            command: Command::Sandbox(SandboxCommand::Prepare { slug, auto, .. }),
        }) = parse(&["sandbox", "prepare", "--auto", "abc123"])
        else {
            panic!("prepare --auto <slug> did not parse")
        };
        assert_eq!(slug.as_deref(), Some("abc123"));
        assert!(auto);
    }

    #[test]
    fn the_slug_is_optional_exactly_where_one_sandbox_can_be_inferred() {
        // update/rollback/dev/prepare fall back to detecting the single sandbox; rebuild never does (it is
        // always handed a specific slug by the Environment card).
        for verb in ["update", "rollback", "dev", "prepare"] {
            assert!(
                parse(&["sandbox", verb]).is_ok(),
                "{verb} must accept a bare invocation"
            );
            assert!(
                parse(&["sandbox", verb, "abc123"]).is_ok(),
                "{verb} must accept a slug"
            );
        }
    }

    #[test]
    fn update_takes_a_channel_by_name_and_refuses_a_bare_one() {
        let Ok(Cli {
            command:
                Command::Sandbox(SandboxCommand::Update {
                    slug,
                    channel,
                    force,
                    skip_preflight,
                }),
        }) = parse(&["sandbox", "update", "abc123", "--channel", "core-stable"])
        else {
            panic!("update --channel did not parse")
        };
        assert_eq!(slug.as_deref(), Some("abc123"));
        assert_eq!(channel.as_deref(), Some("core-stable"));
        // The guard that refuses to update a checkout-built sandbox is only lifted by asking for it.
        assert!(!force);
        // So is the pre-flight's refusal.
        assert!(!skip_preflight);
        // A valueless --channel must not swallow the next thing or default to something.
        assert!(parse(&["sandbox", "update", "abc123", "--channel"]).is_err());
    }

    #[test]
    fn update_force_is_a_flag_that_takes_no_value() {
        let Ok(Cli {
            command: Command::Sandbox(SandboxCommand::Update { force: true, .. }),
        }) = parse(&["sandbox", "update", "abc123", "--force"])
        else {
            panic!("update --force did not parse")
        };
        assert!(parse(&["sandbox", "update", "abc123", "--force", "yes"]).is_err());
    }

    /* `--skip-preflight` lifts a refusal that protects the owner's data, so it binds on every verb that swaps and on nothing that does not. */
    #[test]
    fn skip_preflight_is_a_bare_flag_on_every_swap_and_never_implied() {
        let skips = |args: &[&str]| -> Option<bool> {
            match parse(args).ok()?.command {
                Command::Sandbox(SandboxCommand::Update { skip_preflight, .. })
                | Command::Sandbox(SandboxCommand::Rebuild { skip_preflight, .. })
                | Command::Sandbox(SandboxCommand::Rollback { skip_preflight, .. })
                | Command::Sandbox(SandboxCommand::Dev { skip_preflight, .. })
                | Command::Sandbox(SandboxCommand::Reshape { skip_preflight, .. }) => {
                    Some(skip_preflight)
                }
                _ => None,
            }
        };
        for verb in [
            &["sandbox", "update", "abc123"][..],
            &["sandbox", "rollback", "abc123"],
            &["sandbox", "dev", "abc123"],
            &["sandbox", "rebuild", "abc123", "deadbeef"],
            &["sandbox", "reshape", "abc123", "--memory", "12g"],
        ] {
            assert_eq!(
                skips(verb),
                Some(false),
                "{verb:?} must pre-flight unless asked not to"
            );
            let skipped: Vec<&str> = verb.iter().copied().chain(["--skip-preflight"]).collect();
            assert_eq!(skips(&skipped), Some(true), "{skipped:?}");
            // A bare flag: it must not swallow a value, nor the slug beside it when it comes first.
            let valued: Vec<&str> = skipped.iter().copied().chain(["yes"]).collect();
            assert!(parse(&valued).is_err(), "{valued:?}");
        }
        assert_eq!(
            skips(&["sandbox", "update", "--skip-preflight", "abc123"]),
            Some(true)
        );
        // A prepare never swaps, so there is nothing to skip; accepting the flag would be a promise it ignores.
        assert!(parse(&["sandbox", "prepare", "abc123", "--skip-preflight"]).is_err());
        // Neither does a reshape that only saves or forgets an ask.
        assert!(parse(&[
            "sandbox",
            "reshape",
            "abc123",
            "--memory",
            "12g",
            "--later",
            "--skip-preflight"
        ])
        .is_err());
        assert!(parse(&[
            "sandbox",
            "reshape",
            "abc123",
            "--forget",
            "--skip-preflight"
        ])
        .is_err());
        // A bare reshape applies what is saved, which is a restart, so it takes the flag.
        assert_eq!(
            skips(&["sandbox", "reshape", "abc123", "--skip-preflight"]),
            Some(true)
        );
    }

    #[test]
    fn connect_binds_the_setup_code_positionally_and_yes_is_a_flag() {
        let Ok(Cli {
            command: Command::Sandbox(SandboxCommand::Connect { setup_code, yes }),
        }) = parse(&["sandbox", "connect", "abc123", "-y"])
        else {
            panic!("connect did not parse")
        };
        assert_eq!(setup_code.as_deref(), Some("abc123"));
        assert!(yes);
        // The desktop app and the shims both pass -y; --force is the historical alias the scripts accepted.
        let Ok(Cli {
            command: Command::Sandbox(SandboxCommand::Connect { yes, .. }),
        }) = parse(&["sandbox", "connect", "abc", "--force"])
        else {
            panic!("--force alias did not parse")
        };
        assert!(yes);
        // A codeless connect is legal: the headless path carries CONNECT_TOKEN in the env instead.
        assert!(parse(&["sandbox", "connect"]).is_ok());
    }

    /* A SETUP CODE IS A VALUE, WHATEVER IT STARTS WITH — the shims pass it behind `--` so it stays one. */
    #[test]
    fn connect_takes_a_hyphen_leading_code_after_the_end_of_flags_marker() {
        // Bare, a code like this is argv this parser is right to refuse: it cannot tell it from a flag.
        assert!(parse(&["sandbox", "connect", "-Tq9xk", "-y"]).is_err());
        let Ok(Cli {
            command: Command::Sandbox(SandboxCommand::Connect { setup_code, yes }),
        }) = parse(&["sandbox", "connect", "-y", "--", "-Tq9xk"])
        else {
            panic!("connect did not take a hyphen-leading code behind --")
        };
        assert_eq!(setup_code.as_deref(), Some("-Tq9xk"));
        assert!(yes);
    }

    #[test]
    fn remove_takes_many_slugs_and_its_destructive_flags_are_explicit() {
        let Ok(Cli {
            command:
                Command::Sandbox(SandboxCommand::Remove {
                    slugs,
                    all,
                    yes,
                    agent_auth,
                    now,
                }),
        }) = parse(&["sandbox", "remove", "a", "b", "--agent-auth", "-y"])
        else {
            panic!("remove did not parse")
        };
        assert_eq!(slugs, vec!["a", "b"]);
        assert!(yes && agent_auth);
        // The week of recovery is what a removal gives by default; only --now takes it away.
        assert!(!now, "--now must never be implied");
        // Naming slugs must never widen into --all: that is the difference between removing two sandboxes
        // and removing every sandbox on the machine.
        assert!(!all);
        // -a is --all, and neither is implied by anything: every one of these deletes data.
        let Ok(Cli {
            command:
                Command::Sandbox(SandboxCommand::Remove {
                    all,
                    agent_auth,
                    yes,
                    ..
                }),
        }) = parse(&["sandbox", "remove", "-a"])
        else {
            panic!("remove -a did not parse")
        };
        assert!(all);
        assert!(!agent_auth, "--agent-auth must never be implied by --all");
        assert!(!yes, "-y must never be implied");
        // A bare `remove` is the interactive picker, not an error.
        assert!(parse(&["sandbox", "remove"]).is_ok());
        let Ok(Cli {
            command: Command::Sandbox(SandboxCommand::Remove { now, .. }),
        }) = parse(&["sandbox", "remove", "a", "--now"])
        else {
            panic!("remove --now did not parse")
        };
        assert!(now);
    }

    #[test]
    fn restore_and_purge_are_separate_verbs() {
        let Ok(Cli {
            command: Command::Sandbox(SandboxCommand::Restore { slug, yes }),
        }) = parse(&["sandbox", "restore", "abc", "-y"])
        else {
            panic!("restore did not parse")
        };
        assert_eq!(slug.as_deref(), Some("abc"));
        assert!(yes);
        // A bare `restore` is the picker over what is still recoverable.
        let Ok(Cli {
            command: Command::Sandbox(SandboxCommand::Restore { slug, yes }),
        }) = parse(&["sandbox", "restore"])
        else {
            panic!("bare restore did not parse")
        };
        assert!(slug.is_none() && !yes);
        // Purge ends the window early, and like every other data deletion it is never implied.
        let Ok(Cli {
            command: Command::Sandbox(SandboxCommand::Purge { slugs, all, yes }),
        }) = parse(&["sandbox", "purge", "abc"])
        else {
            panic!("purge did not parse")
        };
        assert_eq!(slugs, vec!["abc"]);
        assert!(!all && !yes);
        let Ok(Cli {
            command: Command::Sandbox(SandboxCommand::Purge { all, .. }),
        }) = parse(&["sandbox", "purge", "-a"])
        else {
            panic!("purge -a did not parse")
        };
        assert!(all);
    }

    #[test]
    fn machine_verbs_parse_and_removal_never_implies_consent() {
        assert!(parse(&["machine", "enroll"]).is_ok());
        let Ok(Cli {
            command: Command::Machine(DeviceCommand::Remove { yes, keep_user }),
        }) = parse(&["machine", "remove"])
        else {
            panic!("machine remove did not parse")
        };
        assert!(
            !yes,
            "machine remove tears down a whole host — consent is never a default"
        );
        assert!(!keep_user);
        assert!(parse(&["machine", "remove", "-y", "--keep-user"]).is_ok());
    }

    /* `docker prepare` is on the shims' critical path — connect.ps1 and connect-host.ps1 both stop dead if it will not parse. */
    #[test]
    fn docker_prepare_defaults_to_asking_and_to_acting() {
        let Ok(Cli {
            command: Command::Docker(DockerCommand::Prepare { yes, dry_run }),
        }) = parse(&["docker", "prepare"])
        else {
            panic!("the shims' own invocation did not parse")
        };
        assert!(!yes, "consent is never a default: this installs software");
        assert!(!dry_run, "a bare prepare is the one that fixes things");

        let Ok(Cli {
            command: Command::Docker(DockerCommand::Prepare { yes, dry_run }),
        }) = parse(&["docker", "prepare", "-y", "--dry-run"])
        else {
            panic!("flags did not parse")
        };
        assert!(yes && dry_run);
        // No positionals: a stray argument must be refused rather than silently ignored.
        assert!(parse(&["docker", "prepare", "extra"]).is_err());
    }

    /* `reshape` changes a container's PRIVILEGES, so its surface is held tighter than the swaps': the slug is never inferred. */
    #[test]
    fn reshape_names_its_sandbox_and_parses_each_ask() {
        assert!(parse(&["sandbox", "reshape"]).is_err());
        // A bare reshape PARSES: it applies the share saved for the next restart, and `recreate::reshape`
        // refuses it at run time when nothing is saved (that check needs the host, not the argv).
        let Ok(Cli {
            command:
                Command::Sandbox(SandboxCommand::Reshape {
                    memory: None,
                    cpus: None,
                    privileged: None,
                    gpus: None,
                    later: false,
                    forget: false,
                    ..
                }),
        }) = parse(&["sandbox", "reshape", "abc123"])
        else {
            panic!("a bare reshape did not parse as an empty ask")
        };
        let Ok(Cli {
            command:
                Command::Sandbox(SandboxCommand::Reshape {
                    slug,
                    memory,
                    cpus,
                    privileged,
                    gpus,
                    later: false,
                    forget: false,
                    skip_preflight: false,
                }),
        }) = parse(&[
            "sandbox",
            "reshape",
            "abc123",
            "--memory",
            "12g",
            "--cpus",
            "4",
            "--privileged",
            "on",
            "--gpus",
            "off",
        ])
        else {
            panic!("reshape did not parse")
        };
        assert_eq!(slug, "abc123");
        assert_eq!(memory.as_deref(), Some("12g"));
        assert_eq!(cpus.as_deref(), Some("4"));
        assert_eq!(privileged, Some(Switch::On));
        assert_eq!(gpus, Some(Switch::Off));
        // One ask is enough, and an untouched switch stays None rather than defaulting to either state.
        let Ok(Cli {
            command:
                Command::Sandbox(SandboxCommand::Reshape {
                    privileged, gpus, ..
                }),
        }) = parse(&["sandbox", "reshape", "abc123", "--memory", "default"])
        else {
            panic!("a memory-only reshape did not parse")
        };
        assert!(privileged.is_none() && gpus.is_none());
        // A switch needs its word: a bare `--privileged` must not be read as "on".
        assert!(parse(&["sandbox", "reshape", "abc123", "--privileged"]).is_err());
        assert!(parse(&["sandbox", "reshape", "abc123", "--privileged", "yes"]).is_err());
    }

    /* `--later` saves an ask for the next restart, so it needs one; `--forget` drops what is saved, so it takes none. */
    #[test]
    fn reshape_later_needs_an_ask_and_forget_refuses_one() {
        let Ok(Cli {
            command:
                Command::Sandbox(SandboxCommand::Reshape {
                    memory,
                    later: true,
                    forget: false,
                    ..
                }),
        }) = parse(&["sandbox", "reshape", "abc123", "--memory", "20g", "--later"])
        else {
            panic!("a saved reshape did not parse")
        };
        assert_eq!(memory.as_deref(), Some("20g"));
        assert!(parse(&["sandbox", "reshape", "abc123", "--later"]).is_err());
        let Ok(Cli {
            command:
                Command::Sandbox(SandboxCommand::Reshape {
                    forget: true,
                    later: false,
                    ..
                }),
        }) = parse(&["sandbox", "reshape", "abc123", "--forget"])
        else {
            panic!("--forget did not parse")
        };
        assert!(parse(&["sandbox", "reshape", "abc123", "--forget", "--cpus", "4"]).is_err());
        assert!(parse(&["sandbox", "reshape", "abc123", "--forget", "--later"]).is_err());
    }

    /* `shape` is the one verb that sets a shape: it always says when, or that it forgets. */
    #[test]
    fn shape_says_when_or_forgets_and_never_both() {
        let Ok(Cli {
            command:
                Command::Sandbox(SandboxCommand::Shape {
                    slug,
                    memory,
                    cpus,
                    privileged,
                    gpus,
                    when,
                    forget: false,
                    skip_preflight: false,
                }),
        }) = parse(&[
            "sandbox",
            "shape",
            "abc123",
            "--memory",
            "20g",
            "--cpus",
            "default",
            "--privileged",
            "off",
            "--gpus",
            "on",
            "--when",
            "next-restart",
        ])
        else {
            panic!("a whole shape for the next restart did not parse")
        };
        assert_eq!(slug, "abc123");
        assert_eq!(
            (memory.as_deref(), cpus.as_deref()),
            (Some("20g"), Some("default"))
        );
        assert_eq!((privileged, gpus), (Some(Switch::Off), Some(Switch::On)));
        assert_eq!(when, Some(When::NextRestart));
        let Ok(Cli {
            command: Command::Sandbox(SandboxCommand::Shape { when, .. }),
        }) = parse(&["sandbox", "shape", "abc123", "--cpus", "4", "--when", "now"])
        else {
            panic!("--when now did not parse")
        };
        assert_eq!(when, Some(When::Now));
        // Saying nothing about when is refused: a shape that silently restarted, or silently didn't, is the bug.
        assert!(parse(&["sandbox", "shape", "abc123", "--cpus", "4"]).is_err());
        // A when with nothing to set is refused; `restart` is the verb that applies what is saved.
        assert!(parse(&["sandbox", "shape", "abc123", "--when", "now"]).is_err());
        assert!(parse(&["sandbox", "shape", "abc123", "--when", "later"]).is_err());
        let Ok(Cli {
            command:
                Command::Sandbox(SandboxCommand::Shape {
                    forget: true,
                    when: None,
                    ..
                }),
        }) = parse(&["sandbox", "shape", "abc123", "--forget"])
        else {
            panic!("--forget did not parse")
        };
        assert!(parse(&["sandbox", "shape", "abc123", "--forget", "--cpus", "4"]).is_err());
        assert!(parse(&["sandbox", "shape", "abc123", "--forget", "--when", "now"]).is_err());
        assert!(parse(&["sandbox", "shape", "abc123", "--forget", "--skip-preflight"]).is_err());
        // Always named, like reshape: this changes a container's privileges.
        assert!(parse(&["sandbox", "shape", "--forget"]).is_err());
    }

    #[test]
    fn power_verbs_take_an_optional_slug_and_list_takes_json() {
        for verb in ["start", "stop", "restart"] {
            assert!(parse(&["sandbox", verb]).is_ok(), "{verb}");
            assert!(parse(&["sandbox", verb, "abc123"]).is_ok(), "{verb}");
            assert!(parse(&["sandbox", verb, "a", "b"]).is_err(), "{verb}");
        }
        let Ok(Cli {
            command: Command::Sandbox(SandboxCommand::Stop { slug }),
        }) = parse(&["sandbox", "stop", "abc123"])
        else {
            panic!("stop did not parse")
        };
        assert_eq!(slug.as_deref(), Some("abc123"));
        assert!(matches!(
            parse(&["sandbox", "list", "--json"]),
            Ok(Cli {
                command: Command::Sandbox(SandboxCommand::List { json: true })
            })
        ));
        assert!(matches!(
            parse(&["sandbox", "list"]),
            Ok(Cli {
                command: Command::Sandbox(SandboxCommand::List { json: false })
            })
        ));
    }

    #[test]
    fn default_is_the_persons_word_for_the_contracts_empty_value() {
        // Forwarded, never interpreted: only the one word this verb documents is translated; a cap's own
        // spelling (right or wrong) reaches the contract as typed, where it is validated by name.
        assert_eq!(seed_value(Some("default".into())), Some(String::new()));
        assert_eq!(seed_value(Some(" default ".into())), Some(String::new()));
        assert_eq!(seed_value(Some("12g".into())), Some("12g".to_string()));
        assert_eq!(seed_value(Some("12G".into())), Some("12G".to_string()));
        assert_eq!(seed_value(None), None);
    }

    #[test]
    fn a_verb_typo_is_refused_rather_than_guessed() {
        // The shims build these command lines; a silently-accepted near-miss would run the wrong flow.
        assert!(parse(&["sandbox", "updat", "abc"]).is_err());
        assert!(parse(&["sandbox"]).is_err());
        assert!(parse(&[]).is_err());
    }
}
