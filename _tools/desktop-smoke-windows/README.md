# @intentic/desktop-smoke-windows

The tiers that meet the Windows installer the way a user's machine does: by **running it**.

The counterpart of [`@intentic/desktop-smoke`](../desktop-smoke), which does the same job on Linux inside a
bare Debian container. This one cannot be a container: the artifact under test is a Windows program with a
window, a tray icon and a registry entry, so it needs a real Windows session. Setting that session up is
[`docs/ci-runner-windows.md`](../../docs/ci-runner-windows.md).

```powershell
pnpm turbo run build --filter=@intentic/desktop-smoke-windows...
node dist/main.js doctor            # the machine, before the product
node dist/main.js install  --installer path\to\Intentic-1.2.3-x64-setup.exe [--expected-version 1.2.3]
node dist/main.js setup             # needs Docker Desktop on Linux containers
node dist/main.js agents            # needs a connected account (see the runner doc)
node dist/main.js teardown          # put the machine back
```

## Why this exists

The Windows installer is cross-compiled on a Linux runner by `cargo-xwin` and, before these tiers, was
**never executed anywhere** before a user double-clicked it. The only automated look inside it was
`verify-desktop-bundle.sh` unpacking it with 7z: which proves the files are in the archive and nothing at all
about what happens when someone runs it. Two of this repo's own comments named the missing piece "the Windows
runner tier" and left the assertions that belong to it written down but unimplemented; this is that tier.

## The four commands

Separate commands rather than one run with flags, because they have genuinely different requirements and a CI
file should be able to say so. Collapsing them would mean the cheapest and most valuable tier could only run
where the most expensive one can.

### `doctor`: the machine, not the product

Every check here exists because its absence produces **a failure that names the wrong thing**: a runner
installed as a service maps no windows and reads as "the app never started"; a Docker in Windows-container mode
answers every probe and then fails an image pull; a machine with the app already installed passes an install
tier that installed nothing. None of those are product bugs and all of them look like one.

It reports, and does not fix. A doctor that installed Docker or uninstalled a leftover app would be making the
machine pass rather than telling you what it is.

### `install`: does it install, launch, and answer a link

No Docker and no credentials. The installer may fetch WebView2 on a bare machine; after installation, the tier
points both app origins at a loopback server and puts failing Docker/CLI stand-ins in the launched app's
environment. Accepting the setup confirmation therefore proves the handoff without contacting the platform,
installing Docker, or downloading a CLI.

| | |
| --- | --- |
| install | the NSIS installer runs to completion unattended, and Windows lists the app afterwards |
| on disk | the executable, and the bundled `scripts/` the app spawns: its entire native capability |
| registration | `intentic://` resolves to a command, asserted **before the app has ever run** |
| deep link, app not running | a real `intentic://setup` link **starts** the app, which asks first, and lands on the setup screen |
| launch | the process survives startup and maps its workspace window |
| web content | the workspace WebView requests the loopback page, rather than merely mapping an empty native frame |
| deep link, app running | the same link reaches the instance already running, through the OS handler |
| one window | …**in the workspace's place**, not beside it: exactly one of the app's windows on screen, and it is the setup screen |
| uninstall | completes silently **with the app still running**, which is the ordinary state at uninstall time |

Three of those rows are worth their own sentence:

**The registration is asserted before first launch**, because that is the one moment the *installer's*
registration is what answers. The app rewrites it on first start, so every assertion made after a single launch
tests the app's own handler and none of them tests the shipped one. That is exactly how a package that
registers the scheme and then drops every link it wins can sit in a release: correct in the archive, correct
once the app has run, dead for the user who just installed it and clicked "set up". On Linux that half was
broken for months while the other half passed on every build.

**The link is fired twice** because it finds the app in one of two states and they share almost no mechanism.
Not running: the OS starts the app *with* the link in argv and the app has to notice it at startup, the
first-time user's path. Running: the OS starts a second copy whose argv the single-instance plugin forwards.

**The one-window row** guards a failure invisible to every other assertion here: a setup screen that opens as a
*second* window satisfies the search above it, and what the user gets is an unasked-for window in front of the
one they were reading. That is not hypothetical — it shipped, as a deliberate exemption for the setup screen,
and onboarding users reported it as "two Intentic windows and I don't know which one is the product". The
Windows driver uses `EnumWindows`, so two visible top-level windows owned by the same Tauri process remain two
rows; `Get-Process.MainWindowHandle` would collapse them and make this assertion empty.

For releases, this tier receives the semantic version as an expected value and reads it back from Windows after
installation. The release workflow builds that candidate once, runs it here, and gives the same downloaded file
to `release-prepare.sh`; publication never cross-builds a replacement after Windows has passed.

### `setup`: does the shipped setup actually go through

Runs `connect.ps1` **as the installer put it on the machine**, spawned the way the app spawns it
(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File …`: Windows PowerShell 5.1, not pwsh 7, because 5.1
is what the app runs and what the site's one-liner lands in, and the two differ in exactly the places these
scripts live).

Reading the script from the source tree would test a file no user ever runs. `verify-desktop-bundle.sh` proves
the bundled bytes match the source; the install tier proves the install puts those bytes on the machine; this
runs exactly them.

Hermetic: the direct-token path `connect.ps1` documents (a connect token instead of a setup code) means no
Cloudflare, no Google, no platform. What it therefore does **not** cover is the setup-code claim round trip,
which needs a Cloudflare token and belongs with the other gated nightly suites.

It also asks the question the shipped scripts do not: whether the daemon can run **Linux** containers. See
below.

### `agents`: is it reachable, is the gate real, does a turn complete

The three questions `setup` deliberately stops short of. `setup` asks the daemon whether it is alive from
inside its own container, which is the right question for "did setup work" and the wrong one for "can this
machine use it".

- **The address a browser derives.** A sandbox on the same machine as the browser skips Cloudflare: the
  container publishes its loopback listener on a host port computed from the sandbox id. This tier computes it
  with the same function (`localDaemonPort`), never a copy of the arithmetic. If that publish is broken on
  Windows, every local user's workspace silently falls back to the tunnel and nobody finds out.
- **Whose daemon answers there**, asked with `docker port` before anything is asked of it. The tier's connect
  token is a constant, so every sandbox it has ever created wants the same host port, and docker refuses a whole
  `run` whose `-p` is held: `ic` then retries WITHOUT the shortcut rather than failing the setup. A leftover
  from an older run therefore answers on that port — reachable, correctly gated, refusing an uncredentialed
  call in the same words — while the container under test publishes nothing. Every assertion below it would
  pass against that stranger, and only the seeded credential would not, which is how a machine's leftover comes
  out as a sentence about the product's auth. `teardown` removes such a leftover; this names it.
- **The gate.** An uncredentialed call must be refused. Worth asserting because a daemon that answers
  everything to everyone is, from every other assertion here, indistinguishable from a correctly gated one.
- **The turn.** Driven with a **control token** at `drive` scope: the credential the product provides for
  "anything outside the browser", which reaches `POST /agent` and the fleet reads and stops short of landing
  anything.

Two harness moves are worth naming plainly, because both stand in for a step a machine cannot take:

The control token is **seeded, not minted**: minting is owner-gated and the owner is a person with a Google
account. Seeding writes the store the daemon reads, inside the container, as root. This is the same shape of
move the browser tier makes when it seeds a signed session cookie instead of signing in to Google.

Seeding creates the store's directory on the way in, and derives it from the path it is writing rather than
naming it a second time. Nothing on a fresh sandbox has made that directory yet: the daemon writes its
identity files when a browser first connects, and this tier never opens one: so the write is the first thing
there, and a directory named twice is a directory that disagrees with itself the next time one of them moves.

The seed is then **read back and compared**, because the payload is one multi-line heredoc crossing two
argument parsers and a shell, and a shell that never saw the end of one writes an empty file and exits 0. Every
way that write can go wrong otherwise reaches the transcript as `/agents answered 401` — a sentence about the
credential, when the truth is about the write.

The AI account is **connected once, by hand**, and shared through a Docker volume the setup mounts at
`/agent-auth`. Connecting one is a subscription OAuth flow through a browser; there is no API-key route in this
product, by design. Absent the volume, the turn stands down naming it and everything before it still runs.

## What this found

The shipped setup checks that Docker is present and that its daemon answers, and **nothing anywhere checked
that the daemon can run Linux containers**. A sandbox is a Linux container; a Docker Desktop in
Windows-container mode passes every probe on the path and then fails the image pull with a manifest error that
names no remedy. That is not a corner case: it is the default state of the Docker preinstalled on Windows CI
images, and one tray-menu click away on any developer's machine.

The check now lives in `ic`'s connect preflight (`_sandbox/ic/src/docker.rs`), which is the one implementation
all three doors go through: pasted one-liner, desktop button, hand-typed `ic`. An *unidentifiable* daemon is
not refused: a preflight that rejects what it cannot identify turns "we could not tell" into "you are
misconfigured".

## Conventions & gotchas

- **Every decision is a pure function beside the call that made it** (`parse.ts`), for the reason `_sandbox/ic`
  gives about its own: this is the logic most likely to be wrong and least likely to be noticed when it is, and
  it is the only part of a Windows tier that can be asserted from a Linux machine. Put new decisions on that
  side of the line too.
- **Nothing assumes a path.** The install location comes from the registry, the executable from listing that
  directory, the uninstaller from the `UninstallString` Windows recorded. Hardcoding
  `%LOCALAPPDATA%\Intentic\Intentic.exe` would produce a tier that keeps passing when the bundler renames
  something and keeps failing when it does not.
- **`ConvertTo-Json` has three shapes** (nothing, one object, an array) so every probe reads its output
  through `asList`. Treating it as an array works on a machine with two matches and throws on the one with
  exactly one, which is a failure that reads as "the app is not installed".
- **Scripts reach PowerShell as `-EncodedCommand`.** Quoting is then not a thing that exists on the way in.
  Passing a script as text means every embedded quote is negotiated twice, and the failures that produces are
  silent: a probe that returns the empty string reads exactly like one that returned "no".
- **Assertions read window titles**, through `@intentic/desktop`: this repo's own answer to driving a Windows
  desktop from Node, and the exact counterpart of the `xdotool` the Linux tier leans on. The app has no test
  hook and should not grow one: the window appearing IS the behaviour a user is promised.
- **Answering the confirmation is itself checked.** Windows only lets a process move the keyboard under
  conditions a CI harness does not meet by default, and it refuses quietly: so a Return meant for the app's
  dialog can land on whatever else is open on that desktop. `focusWindow` is the step that can tell, and its
  refusal is reported as its own failure. Without that, every assertion after it waits out its deadline and the
  log blames the setup screen for a keystroke that was never delivered.
- **A failure never stops the run.** One tier reports every assertion it could make, because the second failure
  is usually what explains the first: "no window" plus "the process exited" is a crash, "no window" alone is a
  hang.

## Not covered here

**The `/agents` page in a browser.** That needs the platform stack (Postgres, the API, the web build) running
beside the sandbox, and the SPA is byte-identical on every OS. This tier proves WebView2 fetched and rendered a
loopback page; browser journeys for the actual SPA live in [`@intentic-app/e2e`](../e2e).

**Real Google sign-in, and real AI-account OAuth.** Both are browser flows against a third party. The first is
stood in for the same way the browser tier stands it in; the second is the one-time manual step in the runner
doc.

**Windows versions other than the runner's**, machines behind corporate proxies, and antivirus interference.
One machine is one machine.

## Key files

- [src/main.ts](src/main.ts): the four commands, and why they are four.
- [src/tier-install.ts](src/tier-install.ts): install, launch, deep link, uninstall.
- [src/hermetic.ts](src/hermetic.ts): loopback workspace plus the harmless setup stand-ins.
- [src/tier-setup.ts](src/tier-setup.ts): the shipped `connect.ps1`, run the way the app runs it.
- [src/tier-agents.ts](src/tier-agents.ts): reachable, gated, and one turn.
- [src/probe.ts](src/probe.ts): what Windows, Docker, and the desktop say is true.
