# The Windows CI runner

One machine, and it exists to do the single thing no other runner in this repo can: **execute
`Intentic-<version>-x64-setup.exe`**. Everything the pipeline otherwise knows about the Windows installer comes from
unpacking it as an archive on a Linux box: the installer is cross-compiled there by `cargo-xwin` and, until
this runner existed, first ran on a customer's PC.

Companion to [`ci-runner.md`](ci-runner.md), which covers the Linux fleet. Nothing here is shared with it: no
`/ci-cache`, no container jobs, no Docker socket mount.

---

## What the machine has to be

| | |
| --- | --- |
| OS | Windows 11, or Windows Server 2022+ |
| Arch | x64: the installer is `x86_64-pc-windows-msvc` and there is no ARM bundle |
| Virtualization | **available inside this machine**, because Docker Desktop's Linux containers need WSL2, which needs it |
| Disk | ~60 GB (the sandbox image is the large part) |
| RAM | 8 GB works; 16 GB is comfortable with a sandbox running |

**A VM is fine and is what most people should use**: but only if its host exposes nested virtualization. A
cloud VM must be a size that offers it. A physical box has it. If WSL2 cannot start, tier 1 still runs (it
needs no Docker at all); tiers 2 and 3 cannot.

**GitHub's own hosted Windows runners are not a substitute.** Their docs say running a VM inside a runner is
unsupported and experimental, and the Docker preinstalled on those images defaults to *Windows* containers:
which answers every probe our setup makes and then fails to pull a Linux image. If you want to try them
anyway, `doctor` (below) answers the question in about ten seconds.

---

## The one setting people get wrong

**The runner must run in a logged-in session, not as a service.** This is the one that costs a day. The Actions
runner is normally installed as a Windows service, and a service runs in session 0, **which has no desktop**.
The app under test has a window and a tray icon, and every assertion in tier 1 reads window titles. Installed
as a service, the app starts, no window is ever mapped, and the log fills with `the workspace window opened
(waited 60s)`: which reads exactly like a broken build.

It is the one setting left because it is the one the pipeline cannot fix for itself: a job runs *inside* the
runner process, so it can no more move that process onto a desktop than it can lift itself by its own collar.
Everything else about the machine's state, the tiers reconcile on their own: see below.

So it is a property of how the runner was REGISTERED, and registering is a script:

```powershell
# From an ELEVATED PowerShell on the runner. Token from Settings > Actions > Runners > New self-hosted runner.
./_tools/scripts/setup-windows-runner.ps1 -Url https://github.com/intentic -Token <registration-token>

# On a box that exists to be this runner and nothing else, add both switches — see "what each costs" below.
./_tools/scripts/setup-windows-runner.ps1 -Url https://github.com/intentic -Token <token> -AutoLogon -KeepAwake
```

Run it on a machine somebody already registered as a service and it takes the service out and puts the logon
task in: `-Repair` does that alone, no token needed. It finds the runner wherever that person put it, by
reading the service's own image path rather than assuming this script's default root, so the bare command
below works on a machine nobody set up with this script. `doctor` asserts the result directly, and names that
command when it fails, so this is also the answer to a runner that mysteriously stopped mapping windows.

```powershell
# From an ELEVATED PowerShell on the runner. Pass -RunnerRoot only if it is somewhere this cannot find.
./_tools/scripts/setup-windows-runner.ps1 -Repair
```

**It refuses while a job is running**, and `-Force` is how you override that. Repairing a busy runner takes the
job down at whatever step it had reached, and what that looks like on the Actions page is a step whose every
assertion passed and whose process then vanished, with nothing in the log naming a cause — the reader has no way
to connect it to a command somebody ran on the box. Waiting is nearly always right; the runner does one job at a
time, so it is minutes.

### And not a console window either

"Not a service" is a statement about the *session*, and it gets read as a statement about *attendance*. Those
are different, and the gap between them is the second way this machine goes quiet: somebody starts `run.cmd` in
a console window, which has a desktop and passes every assertion in tier 1 — and dies with the window, with the
sign-out and with the reboot, and nothing brings it back.

That failure is the least diagnosable one this repo has, because there is nothing to read. Jobs naming
`windows-desktop` queue against a label no machine is answering; GitHub shows them as *in progress* for as long
as you leave them; no run fails, no log is written, and the Actions page looks like a slow pipeline rather than
an absent machine. It stays that way until a person notices.

So the task the script registers is unattended in every way a service is, except the session:

| | |
| --- | --- |
| no window | the listener runs under a hidden host, so there is nothing on the desktop to close by accident and nothing to keep open on purpose |
| self-healing | a repeating trigger re-runs the task every 3 minutes, and the task's `IgnoreNew` policy makes that a no-op while the listener is alive. A crash, a dropped network, a failed self-update or an operator's Ctrl-C is repaired within minutes, by the machine, with nobody signed in |
| survives a reboot | `-AutoLogon`, below |
| does not sleep through work | `-KeepAwake`, below |

Task Scheduler's own restart-on-failure is set too, as the fast path — but it is not a substitute: it only fires
for what the scheduler *calls* a failure, and a listener that exited zero, which is what a graceful stop and most
self-update handoffs look like, is not one. That is the gap the repetition closes.

`doctor` reports which of the three shapes this machine is, and a hand-started runner is a **note in a passing
log** rather than a failure: that runner is running the job that is asking, and the problem is about the next
reboot, not this build. It is worth knowing that the line is there, because it is the only place the answer to
"why did CI stop?" is written down before it happens.

### The two switches, and what each costs

Both are off by default, because each trades away something real and only a dedicated CI box should make the
trade.

**`-AutoLogon`.** After an unattended reboot the runner waits for someone to sign in. This removes that wait by
storing a logon password in the registry in cleartext, which is a poor trade on a machine anybody also uses.

**`-KeepAwake`.** A sleeping runner is an offline runner, and from GitHub's side that is indistinguishable from a
broken one — see the queueing above. This stops the machine sleeping or hibernating **on mains power only**; on
battery it is somebody's laptop and should still be allowed to sleep. It is the only machine-wide setting this
script will make, which is why it asks. The monitor is deliberately left alone: a blanked screen keeps every
window mapped, so it costs the tiers nothing.

A laptop is the machine this matters most on, and it is worth being blunt about it: a lid that closes is a
Windows leg of the pipeline that stops, silently, until somebody opens it.

---

## What the machine does NOT need arranging

Tier 1's subject is a **first** install: run it over an existing one and it is testing an upgrade, a different
code path with different correct answers. So the tier refuses a machine that already has the app: which used
to mean a person had to go and clean it whenever a run was cancelled or a box rebooted mid-install.

It does not any more. **Every Windows tier tears down before it asserts, as well as after.** The teardown
uninstalls the app, clears its `intentic://` registration and removes the sandbox container; it
is idempotent and cannot fail, so a clean machine walks straight through it. Whatever `doctor` objects to after
that is a state the teardown could not reach, which is worth a human.

That is what lets a replacement runner take over with nothing but the registration above. A snapshot-reset
machine is still nicer: it also covers the WebView2 runtime, whose *absence* is a state worth testing on some
runs, since the installer's job on a bare machine includes fetching it: but nothing requires one.

---

## Registering it

`setup-windows-runner.ps1` (above) does the whole of it: downloads the runner, configures it, and registers
the logon task. What it passes, and why, if you ever do it by hand:

```powershell
./config.cmd --url https://github.com/intentic `
             --token <registration-token> `
             --name windows-desktop-1 `
             --labels windows-desktop `
             --work _work `
             --unattended --replace

# then a scheduled task, "run only when user is logged on", with:
#   • the action a HIDDEN host running run.cmd, not run.cmd itself — no console on the desktop to close
#   • two triggers: at logon, and a repetition every 3 minutes for an indefinite duration
#   • multiple-instance policy IgnoreNew, which is what makes that repetition a watchdog rather than a
#     fork bomb: while the listener lives, every repetition is dropped
#   • start-when-available, so a trigger whose time passed while the machine slept is deferred, not skipped
#   • no execution time limit, and run-on-batteries allowed
# NOT svc.cmd install — see above.
```

**`--labels windows-desktop`, and deliberately not `intentic`.** `runs-on` is an AND over labels, so a Windows
box carrying `intentic` would be offered `[self-hosted, intentic]` jobs: every Linux container job in the
pipeline: and fail them all. The Windows jobs name `[self-hosted, windows-desktop]`; nothing else does.

`--url` has to match the scope the token came from: an organisation token pairs with
`https://github.com/intentic`, a repository token with `https://github.com/intentic/intentic`. Crossing them
fails as an unexplained 404 that reads like an expired token.

### What to install on it

- **Docker Desktop**, started, signed in, **on the WSL2 backend / Linux containers**. Needed by tiers 2 and 3
  only.
- **Node and pnpm**: the jobs install them with `actions/setup-node` and `pnpm/action-setup`, so nothing to do
  by hand.
- **Git** for Windows, for `actions/checkout`.

Nothing else. No Rust, no Tauri toolchain: the installer arrives as a build artifact from the Linux runner that
cross-built it. No C or Python toolchain either, which is why every job here installs the smoke tier's subtree
rather than the workspace: packages elsewhere in the tree compile from source on Windows when npm carries no
prebuild for them, and there is nothing on this machine to compile them with.

No machine-wide settings either: no long-path registry flag, no developer mode, no execution-policy change,
no `git config` of any kind. That is deliberate and worth keeping: every one of them is a thing a replacement
machine would silently lack, and the failure it caused would name something else entirely.

---

## The one-time step that unlocks the agent turn

Tier 3 runs a real agent turn, which needs a connected AI account: and connecting one is a subscription OAuth
flow through a browser, which no CI job can perform. The way around it is the product's own answer to "several
sandboxes, one set of credentials": a shared **agent-auth volume**.

Once, by hand on this machine:

1. Create a sandbox on it and connect your AI account in the workspace, as a user would.
2. Note the Docker volume mounted at `/agent-auth` in that sandbox's container.
3. Set the repository variable **`WINDOWS_AGENT_AUTH_VOLUME`** to that volume's name.

Every sandbox the nightly creates then mounts it and comes up already connected. Without the variable the tier
**stands down naming it** and everything up to the turn still runs: the same contract every other gated tier
in the nightly has. Nothing fails for want of a credential.

Use an account you are comfortable having on a CI box. The turn it spends is one sentence with no tools.

---

## The four tiers, and running them by hand

All four live in `@intentic/desktop-smoke-windows`. Build once, then run whichever you want:

```powershell
pnpm install --frozen-lockfile --filter=@intentic/desktop-smoke-windows...
pnpm turbo run build --filter=@intentic/desktop-smoke-windows...

node _tools/desktop-smoke-windows/dist/main.js doctor --needs-docker
node _tools/desktop-smoke-windows/dist/main.js install --installer path\to\Intentic-<version>-x64-setup.exe --keep-installed
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

- `Intentic-<version>-x64-setup.exe`: via `build-desktop.sh <version> --windows-only`. For a release, the serialized release
  workflow builds the versioned candidate once, Windows executes it, and publication stages that same artifact
  with `--windows-prebuilt`; no second installer build can differ after the check.
- `ic-windows-amd64.exe`, because `connect.ps1` is a **bootstrap shim**: the setup flow lives in the `ic` CLI,
  which the shim downloads from the *latest GitHub Release*. Left to do that, the Windows tier would verify
  the last release's flow against this commit's installer. `IC_BIN` (the shim's own local-dev override) is
  how this commit's `ic` is handed in instead. The Linux setup tier does the same thing for the same reason.

---

## When something goes wrong

| What you see | What it is |
| --- | --- |
| Windows jobs sit *in progress* for hours, nothing fails, no log | no machine is answering `windows-desktop`. The runner is not running, and a runner that is not running produces no error anywhere: check Settings > Actions > Runners for `offline`, then whether the box is asleep, signed out, or was only ever a console window somebody closed |
| the runner was there yesterday and is gone today | it was started by hand, not by the logon task. `doctor` says so, in the log of the last run that passed. `-Repair` |
| every window assertion times out | the runner is a service: session 0 has no desktop |
| `already installed` | something the reconcile teardown could not remove: a stuck uninstaller, or an install under a different account |
| `the daemon runs windows containers, not linux` | Docker Desktop is in Windows-container mode: one tray-menu click |
| the app starts, no window, WebView2 reported absent | the installer's runtime bootstrapper did not complete; usually no outbound network |
| `no Docker daemon answers` right after a snapshot reset | Docker Desktop takes up to a minute past login; the job does not wait for it |

The `doctor` output is the first thing to read in any of these: it reports the machine rather than the
product, which is precisely the distinction each of these rows turns on.
