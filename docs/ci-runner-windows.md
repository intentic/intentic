# The Windows CI runner

One machine, and it exists to do the single thing no other runner in this repo can: **execute
`Intentic-setup.exe`**. Everything the pipeline otherwise knows about the Windows installer comes from
unpacking it as an archive on a Linux box — the installer is cross-compiled there by `cargo-xwin` and, until
this runner existed, first ran on a customer's PC.

Companion to [`ci-runner.md`](ci-runner.md), which covers the Linux fleet. Nothing here is shared with it: no
`/ci-cache`, no container jobs, no Docker socket mount.

---

## What the machine has to be

| | |
| --- | --- |
| OS | Windows 11, or Windows Server 2022+ |
| Arch | x64 — the installer is `x86_64-pc-windows-msvc` and there is no ARM bundle |
| Virtualization | **available inside this machine**, because Docker Desktop's Linux containers need WSL2, which needs it |
| Disk | ~60 GB (the sandbox image is the large part) |
| RAM | 8 GB works; 16 GB is comfortable with a sandbox running |

**A VM is fine and is what most people should use** — but only if its host exposes nested virtualization. A
cloud VM must be a size that offers it. A physical box has it. If WSL2 cannot start, tier 1 still runs (it
needs no Docker at all); tiers 2 and 3 cannot.

**GitHub's own hosted Windows runners are not a substitute.** Their docs say running a VM inside a runner is
unsupported and experimental, and the Docker preinstalled on those images defaults to *Windows* containers —
which answers every probe our setup makes and then fails to pull a Linux image. If you want to try them
anyway, `doctor` (below) answers the question in about ten seconds.

---

## The two settings people get wrong

### 1. The runner must run in a logged-in session, not as a service

This is the one that costs a day. The Actions runner is normally installed as a Windows service, and a service
runs in session 0, **which has no desktop**. The app under test has a window and a tray icon, and every
assertion in tier 1 reads window titles. Installed as a service, the app starts, no window is ever mapped, and
the log fills with `the workspace window opened (waited 60s)` — which reads exactly like a broken build.

So: configure the runner, and start it with `run.cmd` from a logged-in console rather than `svc.cmd install`.
To survive a reboot, pair automatic logon with a scheduled task that runs `run.cmd` **at logon** (not at
startup) with *Run only when user is logged on* selected.

`doctor` asserts this directly, and is the fastest way to confirm it before anything else is debugged.

### 2. The machine must reset to a clean snapshot before each run

Tier 1's subject is a **first** install. Run it twice without a reset and the second run is testing an upgrade
over an existing install — a different code path, with different correct answers. The tier refuses rather than
quietly testing the wrong thing, and says so.

A `teardown` step runs after every tier (`if: always()`) and uninstalls the app, clears its `intentic://`
registration and removes the sandbox container, so a machine with no snapshot still works. A snapshot is
better: it also covers the WebView2 runtime, whose *absence* is a state worth testing on some runs, since the
installer's job on a bare machine includes fetching it.

---

## Registering it

```powershell
# From the ORGANISATION's Settings > Actions > Runners > New self-hosted runner (Windows x64).
mkdir C:\actions-runner; cd C:\actions-runner
# ...download and expand the runner tarball the page names...

./config.cmd --url https://github.com/intentic `
             --token <registration-token> `
             --name windows-desktop-1 `
             --labels windows-desktop `
             --work C:\actions-work `
             --unattended --replace

./run.cmd   # NOT svc.cmd install — see above
```

**`--labels windows-desktop`, and deliberately not `intentic`.** `runs-on` is an AND over labels, so a Windows
box carrying `intentic` would be offered `[self-hosted, intentic]` jobs — every Linux container job in the
pipeline — and fail them all. The Windows jobs name `[self-hosted, windows-desktop]`; nothing else does.

`--url` has to match the scope the token came from: an organisation token pairs with
`https://github.com/intentic`, a repository token with `https://github.com/intentic/intentic`. Crossing them
fails as an unexplained 404 that reads like an expired token.

### What to install on it

- **Docker Desktop**, started, signed in, **on the WSL2 backend / Linux containers**. Needed by tiers 2 and 3
  only.
- **Node and pnpm** — the jobs install them with `actions/setup-node` and `pnpm/action-setup`, so nothing to do
  by hand.
- **Git** for Windows, for `actions/checkout`.

Nothing else. No Rust, no Tauri toolchain: the installer arrives as a build artifact from the Linux runner that
cross-built it.

---

## The one-time step that unlocks the agent turn

Tier 3 runs a real agent turn, which needs a connected AI account — and connecting one is a subscription OAuth
flow through a browser, which no CI job can perform. The way around it is the product's own answer to "several
sandboxes, one set of credentials": a shared **agent-auth volume**.

Once, by hand on this machine:

1. Create a sandbox on it and connect your AI account in the workspace, as a user would.
2. Note the Docker volume mounted at `/agent-auth` in that sandbox's container.
3. Set the repository variable **`WINDOWS_AGENT_AUTH_VOLUME`** to that volume's name.

Every sandbox the nightly creates then mounts it and comes up already connected. Without the variable the tier
**stands down naming it** and everything up to the turn still runs — the same contract every other gated tier
in the nightly has. Nothing fails for want of a credential.

Use an account you are comfortable having on a CI box. The turn it spends is one sentence with no tools.

---

## The four tiers, and running them by hand

All four live in `@intentic/desktop-smoke-windows`. Build once, then run whichever you want:

```powershell
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@intentic/desktop-smoke-windows...

node _tools/desktop-smoke-windows/dist/main.js doctor --needs-docker
node _tools/desktop-smoke-windows/dist/main.js install --installer path\to\Intentic-setup.exe --keep-installed
node _tools/desktop-smoke-windows/dist/main.js setup --ic-bin path\to\ic-windows-amd64.exe
node _tools/desktop-smoke-windows/dist/main.js agents
node _tools/desktop-smoke-windows/dist/main.js teardown
```

| | Needs | Where it runs | Roughly |
| --- | --- | --- | --- |
| `doctor` | nothing | before everything | seconds |
| `install` | nothing | desktop changes on main, and **every release candidate** | ~10 min |
| `setup` | Docker Desktop, Linux containers | nightly | ~20–30 min |
| `agents` | the above + `WINDOWS_AGENT_AUTH_VOLUME` | nightly | ~5–10 min |

`install` gating main rather than sitting in the nightly is the point of splitting them: it needs no Docker or
credentials. The installed app talks only to a loopback stub and harmless local command stand-ins; only a bare
machine's WebView2 bootstrap may need the network.

What each tier asserts, and why each assertion earns its place, is in
[`_tools/desktop-smoke-windows/README.md`](../_tools/desktop-smoke-windows/README.md).

---

## Where the artifacts come from

The Windows runner never builds product binaries. Linux jobs cross-build what each workflow needs and upload it:

- `Intentic-setup.exe` — via `build-desktop.sh <version> --windows-only`. For a release, the serialized release
  workflow builds the versioned candidate once, Windows executes it, and publication stages that same artifact
  with `--windows-prebuilt`; no second installer build can differ after the check.
- `ic-windows-amd64.exe` — because `connect.ps1` is a **bootstrap shim**: the setup flow lives in the `ic` CLI,
  which the shim downloads from the *latest GitHub Release*. Left to do that, the Windows tier would verify
  the last release's flow against this commit's installer. `IC_BIN` — the shim's own local-dev override — is
  how this commit's `ic` is handed in instead. The Linux setup tier does the same thing for the same reason.

---

## When something goes wrong

| What you see | What it is |
| --- | --- |
| every window assertion times out | the runner is a service — session 0 has no desktop |
| `already installed` | the snapshot did not reset, or a previous run's teardown did not complete |
| `the daemon runs windows containers, not linux` | Docker Desktop is in Windows-container mode — one tray-menu click |
| the app starts, no window, WebView2 reported absent | the installer's runtime bootstrapper did not complete; usually no outbound network |
| `no Docker daemon answers` right after a snapshot reset | Docker Desktop takes up to a minute past login; the job does not wait for it |

The `doctor` output is the first thing to read in any of these — it reports the machine rather than the
product, which is precisely the distinction each of these rows turns on.
