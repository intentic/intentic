mod cloudflare;
mod contract;
mod docker;
mod health;
mod logfile;
#[cfg(unix)]
mod machine;
mod platform;
mod record;
mod sandbox;
#[cfg(unix)]
mod selfhost;
mod tty;
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
            SandboxCommand::Rebuild { slug, hash } => {
                sandbox::recreate::run(sandbox::recreate::Mode::Rebuild { hash }, Some(slug))
            }
            SandboxCommand::Rollback { slug } => {
                sandbox::recreate::run(sandbox::recreate::Mode::Rollback, slug)
            }
            SandboxCommand::Dev { slug } => {
                sandbox::recreate::run(sandbox::recreate::Mode::Dev, slug)
            }
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
    };
    if let Err(util::Fail(message)) = result {
        eprintln!("error: {message}");
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
