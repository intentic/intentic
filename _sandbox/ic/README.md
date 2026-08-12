# ic

The host-side CLI: the flows that must run on the machine that runs a sandbox — connect, update, rebuild,
rollback, remove, and enrolling the machine as a deploy target.

A sandbox is a container, and it deliberately holds no host Docker socket, so it can never recreate itself.
Every one of these flows therefore runs *outside*, on the user's machine. They used to be ~3,600 lines of
POSIX sh and PowerShell served from intentic.dev, written twice and kept in step by review; now the served
scripts are bootstrap shims (get Docker on, fetch this binary, hand over) and the flow itself is written
once, here, in Rust — a single static binary with no runtime to ship.

## Responsibilities

- `ic sandbox connect` — the setup one-liner's flow: preflight the machine (every prerequisite checked
  read-only, every failure reported at once with its fix), claim the setup code, mint the tunnels, launch the
  sandbox + cloudflared sidecar, verify the whole reachability chain end to end, bootstrap desktop sync, and
  connect this machine as a **computer** so its sandboxes are manageable from the browser. Each stage — and
  any failure, with its fix — is also POSTed to the platform's `/setup/report` (authenticated by the setup
  code), so the browser's setup wizard names why a setup failed instead of guessing from elapsed time.
- `ic sandbox doctor` — the same reachability chain as a read-only diagnosis of an existing sandbox:
  container → daemon → platform registration → tunnel connector → DNS → public URL, every broken link named
  with its fix, exit 1 when anything is broken.
- `ic sandbox update / rebuild / rollback / dev` — swap the container onto a different image, preserving
  /work, /history, the tunnel and every setting; the channel + rollback record makes a bad update reversible.
  A swap that cannot read the approved environment out of a sandbox built from one stops there: dropping an
  environment is never a side effect of asking for a newer image.
- `ic sandbox list / remove` — what is on this machine, and its careful removal (named volumes included).
- `ic machine enroll / remove` — a Linux server as a deploy target: service user, sshd, its own tunnel, the
  POST /enroll self-registration — and the full teardown.

## Key files

- [src/main.rs](src/main.rs) — the command tree, and the map from every env var the shell flows honored.
- [src/contract.rs](src/contract.rs) — the boundary that matters: ic never states the container's run shape,
  it executes what the image's own `intentic sandbox run-command` answers.
- [src/checks.rs](src/checks.rs) — the check engine: checks run to outcomes instead of bailing, the summary
  names every failure with its fix, and `docker::require_daemon` reads the same classification so the
  all-at-once preflight and the hard gates can never drift apart.
- [src/sandbox/doctor.rs](src/sandbox/doctor.rs) — the reachability chain (postflight + `doctor`): patient
  during connect (fresh DNS propagating is ordinary), instant as a diagnosis.
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
- **Two agents are bootstrapped after health, not one.** Desktop sync is gated on `SYNC_DIR` (there is no
  sensible default for which folder to mirror); the computer agent is not, because it asks nothing of the user
  and arrives permitted to touch only this machine's sandboxes. Both go through one code path, run as the
  invoking user under sudo, and neither can fail the setup. `HOST_PAIR_TOKEN` rides the claim like
  `SYNC_PAIR_TOKEN`; `HOST_PLATFORM` and `HOST_LABEL` ride the container's env because the daemon cannot read
  either for itself — it is in a container with its own hostname, on Linux however this machine is spelled.
- **A setup code is what makes the platform part of a run**, and both platform-facing gates say so. The
  preflight probes the platform's origin only when there is a code to redeem against it, and the postflight's
  broken links fail the setup only then too — that is the run someone is watching from a browser, on a
  workspace they will open over the tunnel. A codeless run carries its tokens in the env: nothing calls the
  platform, the outward links belong to whoever wrote the script, and the sandbox it was asked to start is
  started, so the chain is printed as a diagnosis (`ic sandbox doctor` re-runs it) instead of a verdict.
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
