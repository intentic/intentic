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
mod tty;
mod ui;
mod util;

use clap::{Parser, Subcommand};

/* ic — intentic's host-side CLI: the flows that must run on the machine that runs the sandbox, because the
 * sandbox holds no host Docker socket and cannot recreate its own container. The curl-served scripts
 * (connect, rebuild/update, connect-host) are bootstrap shims that fetch this binary and hand over; cleanup
 * stays a self-contained script beside it as the break-glass path.
 *
 * Configuration doubles as flags AND the env vars the shims forward — every name the shell flows honored
 * keeps working (SETUP_CODE, CF_TOKEN, SANDBOX_IMAGE, INTENTIC_SET_ENV, …). */

#[derive(Parser)]
#[command(
    name = "ic",
    version,
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
    Machine(MachineCommand),
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
    },
    /// Download and build the next update WITHOUT applying it, so the update itself is a short restart
    Prepare {
        /// The sandbox to prepare an update for (omit when this machine runs exactly one)
        slug: Option<String>,
        /// Prepare a release channel other than the one this sandbox follows — preparing does NOT move it
        #[arg(long)]
        channel: Option<String>,
    },
    /// Rebuild the owner-approved environment overlay (the Environment card's flow)
    Rebuild {
        /// The sandbox whose overlay was approved
        slug: String,
        /// sha256 of the approved overlay — the trust anchor: only content that still hashes to what the
        /// owner reviewed is ever built
        hash: String,
    },
    /// Back to the image this sandbox ran before its last update
    Rollback {
        /// The sandbox to roll back (omit when this machine runs exactly one)
        slug: Option<String>,
    },
    /// Swap onto the locally-built intentic-sandbox:dev image (the dogfood loop)
    Dev {
        /// The sandbox to swap (omit when this machine runs exactly one)
        slug: Option<String>,
    },
    /// Check every link of a sandbox's reachability chain and name what is broken, with its fix (read-only)
    Doctor {
        /// The sandbox to diagnose (omit when this machine runs exactly one)
        slug: Option<String>,
    },
    /// List the sandboxes on this machine
    List,
    /// Remove sandbox(es): containers, named /work volumes, networks — asks which, confirms, deletes data
    Remove {
        /// The sandbox(es) to remove; none = pick interactively
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
    },
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
enum MachineCommand {
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
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Sandbox(command) => match command {
            SandboxCommand::Connect { setup_code, yes } => {
                sandbox::connect::run(sandbox::connect::Args { setup_code, yes })
            }
            SandboxCommand::Update { slug, channel } => {
                sandbox::recreate::run(sandbox::recreate::Mode::Update { channel }, slug)
            }
            SandboxCommand::Prepare { slug, channel } => sandbox::recreate::prepare(slug, channel),
            SandboxCommand::Rebuild { slug, hash } => {
                sandbox::recreate::run(sandbox::recreate::Mode::Rebuild { hash }, Some(slug))
            }
            SandboxCommand::Rollback { slug } => {
                sandbox::recreate::run(sandbox::recreate::Mode::Rollback, slug)
            }
            SandboxCommand::Dev { slug } => {
                sandbox::recreate::run(sandbox::recreate::Mode::Dev, slug)
            }
            SandboxCommand::Doctor { slug } => sandbox::doctor::run(slug),
            SandboxCommand::List => sandbox::list(),
            SandboxCommand::Remove {
                slugs,
                all,
                yes,
                agent_auth,
            } => sandbox::remove::run(sandbox::remove::Args {
                slugs,
                all,
                yes,
                agent_auth,
            }),
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
fn run_machine(command: MachineCommand) -> util::Result<()> {
    match command {
        MachineCommand::Enroll => machine::enroll::run(),
        MachineCommand::Remove { yes, keep_user } => {
            machine::remove::run(machine::remove::Args { yes, keep_user })
        }
    }
}

/// Windows can't be a native SSH+Docker deploy target — its stand-in is the Docker-in-Docker container
/// `ic sandbox connect` starts with SELF_HOST=1, not an enrolment of the machine itself.
#[cfg(windows)]
fn run_machine(_command: MachineCommand) -> util::Result<()> {
    Err(util::Fail(
        "machine enrolment connects Linux servers. On Windows, deploy locally instead: re-run the sandbox setup with $env:SELF_HOST='1', which stands up a Docker-in-Docker deploy target beside the sandbox.".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    /* THE ARGUMENT SURFACE, asserted — the shims and the platform's cards build command lines against it.
     *
     * This is the same class of risk the desktop crate's commands.rs states: an argument that regresses to a
     * different position or arity binds to the WRONG parameter, silently, and the failure surfaces much
     * later as something else entirely. Here a `rebuild` whose hash became optional would accept a bare
     * `ic sandbox rebuild <slug>` and rebuild against no trust anchor at all. */

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
            command: Command::Sandbox(SandboxCommand::Rebuild { slug, hash }),
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
        // The card and the connected-computer agent build `prepare` and `update` command lines from one
        // place; an argument that binds differently between them would download for one channel and swap
        // onto another.
        let Ok(Cli {
            command: Command::Sandbox(SandboxCommand::Prepare { slug, channel }),
        }) = parse(&["sandbox", "prepare", "abc123", "--channel", "beta"])
        else {
            panic!("prepare did not parse")
        };
        assert_eq!(slug.as_deref(), Some("abc123"));
        assert_eq!(channel.as_deref(), Some("beta"));
        assert!(parse(&["sandbox", "prepare", "abc123", "--channel"]).is_err());
        assert!(parse(&["sandbox", "prepare", "extra", "extra2"]).is_err());
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
            command: Command::Sandbox(SandboxCommand::Update { slug, channel }),
        }) = parse(&["sandbox", "update", "abc123", "--channel", "core-stable"])
        else {
            panic!("update --channel did not parse")
        };
        assert_eq!(slug.as_deref(), Some("abc123"));
        assert_eq!(channel.as_deref(), Some("core-stable"));
        // A valueless --channel must not swallow the next thing or default to something.
        assert!(parse(&["sandbox", "update", "abc123", "--channel"]).is_err());
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

    #[test]
    fn remove_takes_many_slugs_and_its_destructive_flags_are_explicit() {
        let Ok(Cli {
            command:
                Command::Sandbox(SandboxCommand::Remove {
                    slugs,
                    all,
                    yes,
                    agent_auth,
                }),
        }) = parse(&["sandbox", "remove", "a", "b", "--agent-auth", "-y"])
        else {
            panic!("remove did not parse")
        };
        assert_eq!(slugs, vec!["a", "b"]);
        assert!(yes && agent_auth);
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
    }

    #[test]
    fn machine_verbs_parse_and_removal_never_implies_consent() {
        assert!(parse(&["machine", "enroll"]).is_ok());
        let Ok(Cli {
            command: Command::Machine(MachineCommand::Remove { yes, keep_user }),
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

    /* `docker prepare` is on the shims' critical path — connect.ps1 and connect-host.ps1 both stop dead if it
     * will not parse — and it is the one command here whose flags decide whether a machine gets CHANGED. */
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

    #[test]
    fn a_verb_typo_is_refused_rather_than_guessed() {
        // The shims build these command lines; a silently-accepted near-miss would run the wrong flow.
        assert!(parse(&["sandbox", "updat", "abc"]).is_err());
        assert!(parse(&["sandbox"]).is_err());
        assert!(parse(&[]).is_err());
    }
}
