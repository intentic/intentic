# ic

The host-side CLI: the flows that must run on the machine that runs a sandbox — connect, update, rebuild,
rollback, remove, and enrolling the machine as a deploy target.

A sandbox is a container, and it deliberately holds no host Docker socket, so it can never recreate itself.
Every one of these flows therefore runs *outside*, on the user's machine. They used to be ~3,600 lines of
POSIX sh and PowerShell served from intentic.dev, written twice and kept in step by review; now the served
scripts are bootstrap shims (get Docker on, fetch this binary, hand over) and the flow itself is written
once, here, in Rust — a single static binary with no runtime to ship.

## Responsibilities

- `ic sandbox connect` — the setup one-liner's flow: claim the setup code, validate the Cloudflare token,
  mint the tunnels, launch the sandbox + cloudflared sidecar, bootstrap desktop sync.
- `ic sandbox update / rebuild / rollback / dev` — swap the container onto a different image, preserving
  /work, /history, the tunnel and every setting; the channel + rollback record makes a bad update reversible.
- `ic sandbox list / remove` — what is on this machine, and its careful removal (named volumes included).
- `ic machine enroll / remove` — a Linux server as a deploy target: service user, sshd, its own tunnel, the
  POST /enroll self-registration — and the full teardown.

## Key files

- [src/main.rs](src/main.rs) — the command tree, and the map from every env var the shell flows honored.
- [src/contract.rs](src/contract.rs) — the boundary that matters: ic never states the container's run shape,
  it executes what the image's own `intentic sandbox run-command` answers.
- [src/sandbox/connect.rs](src/sandbox/connect.rs) — the setup flow.
- [src/sandbox/recreate.rs](src/sandbox/recreate.rs) — the four swap modes and the rollback record.
- [src/sandbox/remove.rs](src/sandbox/remove.rs) — removal; keep in lockstep with cleanup.sh (below).
- [src/selfhost.rs](src/selfhost.rs) — the root-side machine mutations connect's SELF_HOST and machine
  enrolment share.

## How it fits

The served scripts in `_site/site/public/scripts/` fetch this binary from the GitHub release and forward to
it; the desktop app spawns those same scripts, so all three doors — pasted one-liner, desktop button,
hand-typed `ic` — run this one implementation. How a sandbox container is run is still owned by
`@intentic/sandbox-run` and spoken by the image itself; ic is a caller of that contract, never an author, so
a stale ic still runs a new image correctly.

## Conventions & gotchas

- Every flag doubles as the env var the shims forward (`SETUP_CODE`, `CF_TOKEN`, `SANDBOX_IMAGE`,
  `INTENTIC_SET_ENV`, …) — the one-liners the platform ever handed out keep working.
- `cleanup.sh` and `cleanup-host.sh` stay full scripts on purpose: removal is the flow you reach for when
  things are broken, and it must not depend on a binary that might itself be what is broken. `ic sandbox
  remove` / `ic machine remove` are their CLI twins — change one, change both.
- `connect-host.ps1` (Windows deploy targets) is still script-only: its flow is genuinely different (a
  Docker-in-Docker target with a netns-shared cloudflared), not a dialect of the Linux one.
- Interactive questions read from the controlling terminal, never stdin — the shims pipe this binary's flows
  from `curl … | sh`, where stdin is the script. A failed read is a refusal, never a default.
- **Decisions are split from the IO that acts on them**, and that split is what the tests hook into: the argv
  that asks the image for its run command, the overlay's base check, the rollback record's arithmetic, the
  image-reference classification. Each is a pure function beside the function that calls docker, so the
  logic most likely to be wrong — and least likely to be noticed when it is — is asserted without a daemon.
  Put new decisions on that side of the line too.
- `cargo test` needs nothing installed. Nothing here mutates process env (`set_var` is global and the test
  threads are parallel), so tests that need paths take a tempdir instead of repointing `INTENTIC_HOME`.
