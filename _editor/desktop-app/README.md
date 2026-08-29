# @intentic/desktop-app

The no-terminal way to run an intentic sandbox on your own computer.

A Windows and Linux desktop app that installs the sandbox, and the thing that updates it afterwards. Install it,
sign in, click **Run on this computer**.

```
   ONE WINDOW, THREE SCREENS TAKING TURNS IN IT — never two of them on screen at once

┌─ Intentic ──────────────────┐   ┌─ Intentic, Setting up… ─────┐   ┌─ Intentic, This computer ───┐
│                             │   │ Setting up work on this PC  │   │ ● work        ▶ ■  update   │
│  app.intentic.dev           │ ⇄ │ ▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░  31%  │ ⇄ │ folders · ports · image     │
│  the hosted SPA             │   │ ✓ Check Docker              │   │ agent · logs                │
│                             │   │ ⟳ Download the image        │   │                             │
└─────────────────────────────┘   └─────────────────────────────┘   └─────────────────────────────┘
               │                                │                                 │
               └──────────────────────── Rust shell ──────────────────────────────┘
                              windows · tray · deep link · updater
                                             │
                              sh connect.sh / recreate.sh / cleanup.sh
                              powershell connect.ps1 / recreate.ps1 / cleanup.ps1
```

## What it is: and is not

The app **preserves the product model**: a sandbox is still a Docker container, the UI is still
`@intentic-app/web` talking to the daemon directly, and the browser path keeps working on the same sandbox
from any device. The app adds no third plane. It is three thin native things around the existing product:

1. **A shell for the hosted SPA.** The workspace screen loads `https://app.intentic.dev`
   (override: `INTENTIC_APP_URL`, or settings). It gets **no IPC at all**, its capability list is empty, and
   its only channel into the app is an `intentic://` navigation the window intercepts in Rust.
2. **A script runner.** Every machine operation is one of the scripts the copy-paste one-liners already run,
   spawned as a child process with its output streamed into the app's own screen.
3. **A lifecycle manager.** Setup progress, then one row per sandbox carrying its folder, its localhost ports,
   its image and its verbs: start, stop, restart, update, roll back, logs, remove. What **desktop sync** is
   doing here is read by spawning `intentic-sync status --json` exactly as the lifecycle actions spawn their
   scripts, and the whole row is `@intentic/ui`'s `MachineDetail` with `@intentic/ui`'s `SandboxVerbs` on it:
   the same two components the web app's Computers tab uses, so the two cannot describe one machine
   differently or offer different buttons for it.

   That third item was the app's largest blind spot: `SYNC_DIR` rides the setup link into `connect.sh` and was
   never heard from again, so the window that exists to be the no-terminal way to run a sandbox could show a
   container as up and say nothing whatsoever about the sync the same setup had just configured. The only
   rendering of those facts was `intentic-sync status`, in a terminal.

   Sharing the *component* was not enough on its own, and the second half of that is newer: this window drew
   its containers as cards with their own buttons and then drew the same sandboxes again underneath as folders
   and ports, under a second heading, with nothing on screen relating the two: the exact double-rendering the
   Computers tab had already been rebuilt to remove. It now hands its containers to the same view, so a
   sandbox is one row here too. The verbs likewise: this window had a log tail and no Restart, the tab had a
   Restart and no log tail, and neither offered the rollback both of their backends could already run.

## Two webviews, one window

There have to be two webviews: Tauri scopes capabilities by window **label**, so giving the hosted SPA the
same label as the local UI would hand `app.intentic.dev` that UI's permissions. What the user is owed, though,
is not one webview but one **window**: and the first version of this app did not deliver it. Clicking *Set up
on this computer* in the SPA opened a second, differently-titled window ("Sandbox Manager") on top of the one
being read, which is where first-time users stopped.

So `windows.rs` keeps exactly one of them on screen: whichever screen is being shown first takes the other's
position and size, then the other hides. The title follows the content (`App.vue` sets it), the frame does
not, and clicking a handoff reads as the window changing screens.

**The setup screen was exempted from that for three releases, and the exemption is what this section is now
mostly about.** The argument was good on paper: an install is not somewhere the user *went*, it is something
happening to the app they are already in, so the launcher came up *in front of* the workspace rather than
instead of it. It wore three shapes while that argument held — a full window, then an undecorated topmost
sheet across the workspace's rectangle, then a small movable dialog centred on it that grew to fit its own
card — and every one of them delivered the same thing to the person it was for: **two Intentic windows, two
taskbar buttons and two alt-tab stops, during onboarding.** Onboarding is precisely the flow where a new user
cannot yet tell which of two windows is the product. The reported complaint was exactly that.

An install is a **screen** of this app now, and it arrives the way every other screen does: `show_launcher`
takes the workspace's frame, the workspace hides, the title says which screen is up. There is one entry point
because there is one gesture, and no `SETUP_SIZE`, no `set_setup_frame`, no `fit_setup` and no
"is this window wearing the setup frame" flag in `state.rs` — all of that existed only to manage a second
frame, and a second frame is the thing that was wrong.

Two consequences fall straight out of the collapse. The screen is **top-anchored and wider** (`max-w-3xl`)
rather than a card floating in a small dialog, because it now has a full window's height to use: the failure
that produced `fit_setup` — a Windows PC reporting four things wrong with itself, with every one of them plus
the button that fixes them below the fold of a 620×640 window — is answered by the room, not by resizing the
frame under the reader. And the card's **×** is a labelled *Back to your workspace* instead: a bare × on a
window-filling screen reads as "close Intentic", which is the one thing it does not do. Either way out steps
back to the workspace and stops nothing, the script being a process on this machine rather than something the
window is holding up.

**A window that fits the screen still has to be put on it, and for a while only the first half was done.**
`fit_to_screen` stopped the app asking for a window taller than the display; nothing then chose where that
window went. Tauri leaves an unplaced window to the platform, and the platform's answer on Windows is
`CW_USEDEFAULT`: the cascade, which steps each new window down and right from the top-left corner. A window
fitted to the full height of the work area and then pushed down by that cascade puts its bottom edge under the
taskbar, and on a first run the strip that goes missing is the one holding the chat composer: the single
control the whole screen exists for, absent from the first impression the app ever makes. So a cold start is
now *placed* as well as sized (`opening_position`): centred on the work area rather than on the monitor
(Tauri's own `center()` does the latter and hands back half a taskbar of the same overhang), centring the
outer rectangle rather than the inner one, and offset by the work area's own origin, which is not `(0, 0)` on
a second monitor or with the taskbar docked left. A swap that has a real frame to inherit still overrides it:
the window the user is already looking at outranks the middle of the screen.

Both smoke tiers assert the **count**, because the count is the property: after a setup link, exactly one of
the app's windows is on screen and it is the setup screen. They spent two rewrites asserting geometry instead
— equal rectangles for the sheet, then smaller-and-centred for the dialog — and both of those pass with a
second window mapped, which is the whole of what was wrong. Worth remembering when reading their history: a
test that agrees with the code is not the same as a test that agrees with the user.

Three more consequences worth knowing:

- **A cold start with the SPA's own link opens no workspace first.** `intentic://setup` in argv means the setup
  screen is what appears: otherwise the app would load the SPA only to swap it away a frame later. With no
  frame to inherit the window centres on the work area instead.
- **A finished install lands *in* the workspace, not on the page that was waiting for it.** Handing the frame
  back without a destination returns the webview to `/setup`, which then has to notice for itself that the
  daemon is up. It does (it re-polls on focus), but the last thing a four-minute install would show is a
  screen saying it is still waiting, so the hand-back navigates to the app's root — the same place the SPA's
  own `enterWorkspace` goes.
- **A parked setup runs on arrival: when the SPA's own window asked for it.** That button is the consent;
  asking again on a screen the user did not open is what made the handoff feel like a second, unrelated
  installer. It is also the *only* direction that consent covers, which is what [the link's
  source](#a-link-from-outside-is-not-a-link-from-us) is about.
- **Closing the workspace face asks what to do; by default it hides and the app lives in the tray.** The window
  is hidden rather than destroyed, so reopening is instant and the webview keeps the session it signed in with.
  Closing the launcher face is a step back to the workspace.

  The cost of that model is a process the user cannot see, and it has already been paid once: nobody found the
  tray icon, and the app was met instead as the uninstaller's *"Intentic is running"* prompt. Windows is why:
  it files new tray icons behind the overflow arrow by default and no app can promote itself out of there. Two
  things answer it, and neither is optional to the design: the **×** raises the app's own confirmation before
  anything moves, and the uninstaller **closes the app itself** instead of asking
  ([`installer-hooks.nsh`](src-tauri/installer-hooks.nsh), which `installer.nsi` inserts ahead of its own
  running-app check).

### The × is a question: `confirm-close`

The first answer to the invisible-process problem was a notice *after* the fact: the window vanished and an OS
message box reported that Intentic was "still running". It reported rather than asked, so the only gesture it
left was **OK** to something already done: and every native message box carries an icon, which is what makes
Windows play the alert chime at it. A window closing exactly as designed sounded like a fault.

So the close asks first, and the dialog is a **third window label** ([`windows.rs`](src-tauri/src/windows.rs),
`ask_before_closing` → [`CloseConfirm.vue`](src/CloseConfirm.vue)) rather than a native box. Being this app's
own window is not decoration: it is the only way to draw the thing silently, and the only way to offer more
than one button. Three things follow from it:

- **It is a dialog, not a third face.** Off the taskbar, owned by the frame it is about, centred over it, and
  destroyed on answer: so it is one thing on screen for the same reason the setup window is. It is titled
  `Close Intentic?`, which deliberately does not start with the workspace title those assertions match on.
- **Two answers, and remembering one retires the question.** *Keep it in the tray* and *Quit Intentic*, with
  **always do this** storing the choice in `close-action.json`: outside `Settings`, which the launcher UI
  overwrites wholesale, so changing an origin there cannot put the question back. Escape, Cancel and the
  dialog's own × mean the window stays; there is no command for that, because nothing happens.
- **It answers off its own IPC callback** (`commands.rs`), because answering destroys the webview that called
 : the same WebView2 COM re-entrancy the workspace's navigation handler steps around.

## Why it runs the scripts instead of reimplementing them

The first attempt at this app (archived 2026-07-19, revived here) put the machine work in Rust: an
environment probe engine, a reconcile plan, a docker-run builder, the `/setup/claim` call, tunnel
provisioning, the sandbox lifecycle. That is ~1,400 lines whose only job is to stay bit-identical to
`connect.sh`: a lockstep that has never held anywhere in this repo (see `@intentic/sandbox-run`'s header for
the last time it broke), and the reason the experiment was shelved.

Spawning the scripts makes parity structural: the desktop path and the terminal path are the same file, and a
fix to the flow reaches desktop users without anyone porting it. The scripts themselves are bootstrap shims
now: the flow lives in the `ic` host-side CLI (`_sandbox/ic`), which each shim fetches from the release and
hands over to: so the app, the pasted one-liner and a hand-typed `ic` all run one implementation. What is
left in Rust here is the three things a script cannot do for itself: find itself, get the elevation it
needs, and say what it is doing to a window instead of a terminal
([`src-tauri/src/scripts.rs`](src-tauri/src/scripts.rs)).

| Action | What it spawns |
| --- | --- |
| A handed-over setup (runs on arrival) | `connect.sh` (through `pkexec` only when Docker is missing) / `connect.ps1` |
| Update · Rebuild · Roll back | `recreate.sh <slug> [<sha256>\|--rollback]` / `recreate.ps1 -Slug … [-Hash …\|-Rollback]` |
| Remove | `cleanup.sh <slug> -y` / `cleanup.ps1 -Slug … -Yes` |
| Start · Stop · Restart · Logs | `docker` directly: there is no script that lists, cycles or tails |
| The desktop-sync panel | `intentic-sync status --json` (its own install under `~/.intentic/sync/bin` first, then PATH) |

The scripts are **bundled as resources** from `_site/site/public/scripts/`, by way of a staging directory:
[`_tools/scripts/stage-desktop-scripts.sh`](../../_tools/scripts/stage-desktop-scripts.sh) empties
`src-tauri/staged-scripts/` and refills it from `git archive HEAD` before every build, and `tauri.conf.json`
globs *that*: so a script added to the site is bundled by construction, and a file the commit does not carry
cannot be, however long the runner has kept its checkout. The trade is that an **uncommitted** edit to a
script does not reach a local installer or `tauri dev`; commit it. A release of the app is cut from one
commit, so `Intentic 1.2.0` ships `connect.sh@1.2.0`.

### …and the CLI they fetch is pinned to the same release

The shims download `ic` on every run, and until recently they took it from `releases/latest`: so the app's
bundled scripts came from one commit and the binary they hand over to came from whatever was newest. The app
installs its own updates only when the user next quits it, which makes "a release behind" an ordinary state,
not an edge case.

That is not a cosmetic drift. The `intentic-requirement:` protocol and the two-pass consent flow the Windows
setup screen is built around arrived in a single commit: an app older than it receives those lines, has no
parser for them, has no requirements list to draw, and does not know that the first pass is *supposed* to
stop: which is a Windows install that reports nothing and appears to hang on "checking Docker".

So `setup_script` sets `IC_URL` to this build's own release tag, through the base-URL override every shim
already honours. A build with no version (`tauri dev`, any local build) sets nothing and takes `latest`,
because a checkout has no matching release to pin to. Flow fixes now reach app users through an app update
rather than behind its back: which is the same trade the bundled scripts already make, applied to the one
piece that was exempt from it.

### The scripts say which phase they are in, not just what they are doing

Every phase of an install is announced as `intentic: [<phase>] <sentence>`, `connect.sh`'s `step()`,
`connect.ps1`'s `Write-Step`, `ic`'s `util::step`, one contract in three languages, and the ids are the same
vocabulary the platform's setup report uses (`SetupReportSchema.stage`), so this window's bar and the
browser's wait screen name the same phase. Anything printed *without* one is detail under the step that is
running.

That id is what makes a progress bar possible at all. The window used to show one line: whatever the script
last said: with the log behind a disclosure, which is enough to *read* a run and nothing like enough to
*wait* through one: the two questions somebody in front of a four-minute image pull actually has, is it stuck
and how long, were both unanswerable. `setupPlan.ts` answers them:

- **The whole plan is drawn before the first line of output**, and only the steps that will run on this
  machine are in it: no `Install Docker` row where Docker is already up, no `Set up folder sync` where the
  setup link carried no folder. Nothing on the list is ever skipped in front of the reader. The one row that
  needs an answer from the machine is the Docker one, and the probe behind it is deliberately not waited for
  (see above): a plan drawn before it lands is drawn without that row and redrawn with it, but only while the
  cursor has not moved yet: after the first phase marker the reader is following the list they were given.
- **The bar is weighted by how long each step takes**, not by how many there are. A step counter alone sits at
  "6 of 10" through the longest part of an install and then finishes four steps in as many seconds.
- **The image pull reports real progress.** Spawned without a terminal, `docker pull` cannot draw its bars and
  prints one line per layer per state change instead, which is better for us: counting them is honest
  progress through the biggest download in the install. The bar is clamped monotonic, because the layer total
  only becomes known as docker announces it.
- **Silent steps still move**, on the step's own weight against the clock, capped short of the end: only the
  script gets to say a step is over.
- **The estimate is the plan corrected by the run.** Remaining weight at the pace this machine has actually
  managed so far, so a slow disk stretches the number instead of being contradicted by it.
- **A weight is a claim about how long something takes, and a wrong one is a lie the bar tells at the worst
  moment.** `connecting-machine` was 20 — the same as `Check it answers` — for a step that downloads the
  ~100 MB host agent and prints nothing between "Downloading…" and "done". So a first install reached 99% and
  "less than a minute left" *before* that download began, and then stopped moving: the full-bar freeze is the
  shape people read as a hang, arriving at the one point where they are readiest to believe the install had
  finished and something afterwards had broken. It is 75 now, sized against `pulling-image` by what each
  actually transfers.
- **Only what the reader is meant to read reaches the log pane.** The `intentic-requirement:` and
  `intentic-requirement-state:` markers are protocol — the requirement rows *are* their rendering — and they
  used to be parsed *and* appended, so the pane showed raw JSON running off its right edge, inside the one
  surface this app asks people to copy into a support thread. `readMarker` (`desktop.ts`) answers once and the
  handler drops what it recognises. The transcript on disk still records every byte, which is the right place
  for the machine's half of the conversation.

### When it stops, somebody has to find out

A Windows install once reported four specific things wrong with the machine, exited, and the user saw a
spinner. Nothing about the diagnosis was wrong; every part of *delivering* it was. That failure had five
separate causes and all five are closed here, because any one of them alone reproduces it:

- **The requirements lead the card**, above the progress plan rather than under it, on a screen that now has a
  whole window's height for them (above). They were previously the last thing on a card taller than its window.
- **A non-zero exit is not automatically a failure.** Every Windows install that needs anything ends its first
  pass non-zero *by design*: the flow reports what it would change and stops, because there is no terminal
  here to ask the one question on. `ic` now says which stop that was with a documented exit code
  (`docs/cli-output-protocol.md` §2c), and the screen renders it as the list, never as `connect.ps1 exited
  with status 3`.

  **The progress bar was the last thing that still disagreed.** It derived "failed" from the exit code alone,
  so a run stopped for consent drew `Stopped` in danger red over a 4% bar, directly above a card politely
  asking for one click — the screen calling its own two-pass design a crash, on the single click the flow
  exists to earn. `awaitingConsent` is that fact hoisted out of `runSetup` so both halves read it: the heading
  becomes *Waiting for you*, the bar goes amber, and the estimate disappears rather than counting down against
  a clock the user is holding.
- **The setup face is latched, not derived.** It used to be `pending !== undefined || activeRun === 'setup'`,
  where `pending` is cleared by the run that starts and re-read from two directions: so ordinary orderings
  could end with both halves false while a failed setup was on screen, handing the window back to the manager
  face and taking the failure with it. `take_pending_setup` is now take-once, and only finishing or the ×
  closes the screen.
- **A stopped run takes the window back** (`setup_alert` → unminimise, show, `request_user_attention`). This
  window is deliberately not topmost and deliberately minimisable, which is right for something that runs for
  minutes and exactly why a failure nobody was looking at changed only pixels. It *swaps* when — and only
  when — the workspace has the frame, because walking away from a running install hands it back, and a bare
  `show()` from there would put this face up beside the workspace: the second window again, on the one screen
  that most needs reading carefully. That case takes focus, since the window being read is the one stepping
  aside; every other case stays a show and a hint.
- **Every run writes a transcript to `~/.intentic/logs/desktop-<id>-<stamp>.log`**, whether or not anyone
  asks, with **Copy log** and **Open log folder** on the card. Before this, a run existed only as events in
  one webview: closing the card destroyed the only evidence there was.

Two more things the screen gained at the same time:

- **Stop.** There was no way to end a run. "You can close this: the install keeps going" was the whole of the
  offer, so a run that had gone wrong could be walked away from and not stopped, and the next attempt raced the
  one still going. `run_stop` kills the tree (`taskkill /T` on Windows; the child leads its own process group
  on Unix).
- **Live requirement rows.** `ic` reports each requirement's own state as it works through it
  (`intentic-requirement-state:`), so the list ticks over in place: instead of one spinner on "Set up Docker"
  for the ten minutes it takes to switch WSL2 on, download 600 MB, run an installer and wait for an engine.

  **A question that has been answered stops being asked.** `carried` keeps the previous run's rows up while
  the next one re-examines the machine, which is right for the seconds it was written for and wrong for the
  four minutes after: an install at 97%, every step green, still carried "Before your sandbox can run here: /
  Docker Desktop is not running." above it with a dead **Install and continue** under that. The buttons now
  leave when the run starts (a disabled control is still a control, and three of them under a list reporting
  live progress read as a card that had not noticed), and `requirementsSettled` retires the whole card once
  every row reports `done`.

- **The button says what will actually happen.** It read *Install and continue* for every list, including the
  commonest one on a developer's machine — Docker Desktop installed and merely not running, where nothing is
  installed and the entire job is to start it. It is *Do this and continue* / *Do these and continue* now,
  which is the promise each row already carries ("we'll do this") collected into the control that grants it,
  so the two cannot drift.

### The way out that is not giving up

The list above is a machine being asked for administrator, a 600 MB download and a restart, and some of the
people reading it are on a PC where none of that will happen: a locked-down work laptop, a machine too small,
an account with no admin. The browser has offered a cloud machine and a hosted one all along; the app hid them
on the argument that "this computer" is the whole point of being in it. That holds right up until this
computer cannot, and then it is a dead end.

So the requirements card carries one quiet line (*Not on this computer? Run it in the cloud instead*) which
hands the window back to the SPA's setup page at `?elsewhere=1`, where those rungs are open. Local stays the
loud, preselected default everywhere else, including the same page reached any other way.

## Sign-in never happens in the webview

Google refuses OAuth authorization from an embedded webview, and Google Identity Services is FedCM-based,
which WebKitGTK does not implement. The archived version answered both with a Safari user-agent spoof; that is
a workaround with an expiry date nobody controls, on the one screen a new user cannot get past.

So the app never asks Google for anything. It opens the platform's own page in the **default browser** and
picks the result up over the deep link it already intercepts:

```
app      opener    →  app.intentic.dev/desktop-auth?state=<nonce>&challenge=<hash>  (real browser)
browser  signs in  →  platform parks {one-time token, Google ID token, challenge} for ONE pickup
browser  redirect  →  intentic://auth?handoff=<id>&state=<nonce>
app      navigate  →  app.intentic.dev/desktop-auth/complete?handoff=<id>&verifier=<secret>  (webview)
```

The last step is why nothing is injected from Rust: the webview fetches that URL itself, redeems the row, and
spends the Better Auth one-time token at `/api/auth/one-time-token/verify`: whose `Set-Cookie` lands in the
webview's own jar exactly as it would in a browser. The Google ID token is spent once at the daemon's
`system.session` for a daemon session that renews silently, so Google reappears only when that cannot renew.
Credentials and the verifier never ride the deep link: a deep link is delivered as a process argument,
readable by anything else on the machine, so only the row's id travels that way.

**The browser this opens in is usually signed out, and the page has to handle that itself.** The app asks the
OS for the default browser, which is not the window the user downloaded the installer in: a different profile,
or an incognito tab that is closed by now. That page used to sit behind a session guard, so the ordinary case
was a bounce to `/login`, which drops the `state` and `challenge` above and ends by pushing into the
workspace. The result read as success and was not: the browser sat in a signed-in workspace while this app,
which had just opened it, was still showing its own Google button. An account that already existed made it
*more* convincing, since the push landed on a real workspace rather than on setup. `/desktop-auth` carries no
guard now — it resolves its own session and, when there is none, signs in with the very Google credential it
has to mint for the app anyway, which is the same one-sign-in trade the login screen makes.

**"When that cannot renew" needs a door, and for a long time it had none.** The login screen offered this
hand-off; the workspace's own sandbox sign-in gate did not: it rendered Google's button, which in this
webview appears, accepts clicks, and does nothing. A person whose adopted ID token expired before a daemon
existed to spend it on (an install that goes on to create and boot a sandbox takes longer than Google's hour)
met that card with no way past it and no way to sign out from behind it. The gate now offers
`intentic://signin` in this app, and the browser page re-mints rather than passing on a nearly-dead cached
token, so the hour is spent where it is useful. The browser receives only a
hash of the verifier; the desktop process retains the secret until the webview redeems the handoff. Racing the
public id therefore cannot collect or consume the credentials intended for the app.

## The link surface

Four actions, and it is the whole channel between the SPA and the app
([`src-tauri/src/setup_link.rs`](src-tauri/src/setup_link.rs), built browser-side in
[`_editor/web/src/environments/desktop.ts`](../web/src/environments/desktop.ts)):

| Link | From | What it does |
| --- | --- | --- |
| `intentic://setup?code=…` | Setup step 3 | run this setup code's sandbox here |
| `intentic://recreate?slug=…[&hash=…][&rollback=1]` | the Update / Environment cards | update, build the approved overlay, or roll back |
| `intentic://signin` | the login screen | sign in, in the user's real browser |
| `intentic://auth?handoff=…&state=…` | the browser, after sign-in | the credential coming back |
| `intentic://update` | the SPA's own update banner | install the app update already downloaded here |

The first four work from an external browser too, where the OS routes them to the installed app: with the one
difference the next section is about. **`intentic://update` is the exception and is refused from anywhere but
this app's own window.** What it does is end the process and run an installer, which is a fine thing for a
button this app drew to ask for and not something a page in a browser should be able to do to somebody who
answered *"Open Intentic?"*. There is nothing to confirm afterwards that would make it a fair question: the
answer is that your app closes now. Out of a window, the tray row is the way to reach it — on the machine,
rather than on the web.

### A link from outside is not a link from us

`intentic://` is a public scheme. Any page can navigate to one, and what the user is shown before the OS hands
it over is *"Open Intentic?"*: a question about opening an app, not about what the link then does. So
`setup_link.rs` records which of the three directions a link arrived from, and the app believes an external one
less:

- **`platform` and `cfToken` are dropped** from an external setup link. `platform` names the server the setup
  code is redeemed against, and that server's answer decides the new sandbox's connect token, the tunnel that
  publishes it, and **which account owns it**: so a stranger's copy stands up a sandbox on this machine that
  answers to them. Nothing real is lost: the SPA sets `platform` only against a localhost platform in local
  dev, and `cfToken` was already documented as riding the in-app webview only (that was enforced on the
  sending side alone, which is no enforcement against a sender who is not us).
- **An external setup asks first**, in the OS's own dialog, naming the container, the fact that it is published
  on the internet, and the folder `syncDir` would mirror into it. Cancel is the default. It is the same shape
  as the `state` nonce on an auth handoff: a request this process cannot tie to something it started is not one
  it acts on.

**How a link gets in** depends on whether the app is already running, and the two paths share nothing but the
url. If it is, the OS starts a second copy and `tauri-plugin-single-instance` forwards that copy's argv to the
first over DBus. If it is not, the OS starts the app *with* the link in argv: which is the path a first-time
user takes (install, click **Set up on this computer**, nothing running yet) and it needs two things the warm
path does not:

- **`%u` on the installed entry's `Exec`.** A handler without a field code is launched with no arguments at all
  (desktop-entry spec), so it wins the lookup and then drops every link it wins. Tauri's bundler writes the
  `MimeType` line but no field code, so the deb and rpm entries come from
  [`src-tauri/main.desktop`](src-tauri/main.desktop) instead of its built-in template.
- **Reading the url back in `setup()`.** `tauri-plugin-deep-link` captures argv during its own plugin setup and
  emits it there (before the app's `on_open_url` listener exists) and nothing replays it. `setup()` asks for
  what it captured (`deep_link().get_current()`) rather than waiting for an event that has already been sent.
- **Nothing on the way to that screen may ask about the machine.** The launcher window is *built* by the
  arriving link, so everything `App.vue` does on mount is between the user's *"Set up"* and the first thing
  they see. `desktop_info` used to probe Docker in that stretch, and `docker info` against a daemon that is
  installed and not running: the ordinary state of a PC that is about to be set up: takes tens of seconds to
  refuse. Worse, it was a sync command, and those are dispatched on the main thread, so the window could not
  even be titled while it ran. The probe is now `docker_ready`, its own `async` command, started on mount and
  waited for by nobody; the one step of the install plan that depends on the answer is redrawn if it arrives
  late. What the app *is* (`desktop_info`) is all values the process already holds, so it stays instant.

None of the three is exercised by firing a link at a running app, which is why the smoke tiers fire one at a
stopped one too: and the last of them is invisible on a fast machine, so it was CI's slow ones that found it.

## What it reports about itself

The workspace face is the hosted SPA and carries that app's instrumentation. This face is the half that touches
the machine, and it used to report nothing: so every desktop funnel ended at *"clicked the button"* and the
install's outcome was invisible. It now sends named events of its own
([`src/analytics.ts`](src/analytics.ts)):

| Event | When | Carries |
| --- | --- | --- |
| `desktop_app_opened` | the Docker probe started at mount answers | whether Docker already answers |
| `desktop_install_started` / `_finished` | a handed-over setup runs | outcome, duration, exit code, and the step it stopped on |
| `desktop_install_dismissed` | the setup card is closed | whether the run was still going, and how far it had got |
| `desktop_install_stopped` | the user ends a run with **Stop** | how far it had got |
| `desktop_install_elsewhere` | the requirements card's cloud escape hatch is taken | which prerequisites made them take it |
| `desktop_install_restart` | Windows is restarted **or signed out of** mid-setup | which of the two, and which prerequisites asked for it |
| `desktop_install_resumed` / `_resume_expired` | the app comes back after that restart | how long the parked setup sat there |
| `desktop_recreate_started` / `_finished` | an update or an environment rebuild | the same, plus which of the two, and whether it came from this screen or from the SPA's card |

Two of these exist because the funnel lies without them. **Dismissal**: the × stops nothing, the script is a
process on this machine: so a run somebody walked out on still reports its own `_finished`, and without this
event a setup watched to the end and one abandoned ninety seconds into a four-minute pull are the same shape.
**Restart**: it is the step that costs a Windows setup the most people, and it is the one event that cannot
fire and forget, because the line after it takes the machine down. `trackBeforeExit` holds the reboot for up
to a second and a half rather than letting the request die on the wire.

`desktop_install_finished` is **the desktop funnel's last step**. The SPA has its own `sandbox_connected`, but
on this path it is fired by a page that spent the whole install parked behind this window: late where a hidden
webview throttles its timers, and never where the handover came from a browser tab the user then closed. Exit
zero here is the same fact that page was waiting to observe, reported from where it happens.

Two things make the join and the restraint work:

- **The install id** (`state.rs`): random, minted once, kept in the app's config dir. The launcher sends its
  events under it, and the workspace window is marked with it, so the SPA carries it as a property too
  ([`web/src/composables/analytics.ts`](../web/src/composables/analytics.ts)). Without it the two webviews:
  separate origins, separate storage: read as two unrelated strangers. It says *this installation*, never a
  hostname, a username or anything about the machine.
- **What may be sent**: outcomes, durations, and the `intentic: …` step labels the scripts print about
  themselves: strings this repo writes. Never a sandbox name, a setup code, a folder path, a Cloudflare token,
  or a line of script output, all of which are on screen in the log beside them.

A plain `POST` per event rather than `posthog-js`, because everything the SDK is worth carrying for is
something this screen must not do: autocapture and pageviews on one log and three buttons, session replay of a
machine's install output, a storage layer for an id already on disk. The key is baked in at build time and is
**empty in every local and CI build**, which switches the whole thing off: only installers a user downloads
report anything.

## Layout

- `src/`, the app's own UI (Vue + `@intentic/ui`): the setup window and the sandbox manager, switched on
  whether a setup is in hand. One component of its own (`SetupProgress.vue`, the install's plan and bar) over
  one pure model (`setupPlan.ts`), one bridge module (`desktop.ts`) and one reporter (`analytics.ts`); the
  sandbox rows, their verbs and their output pane all come from the kit, so this app has no second opinion
  about them. The archived three-persona wizard is not here.
- `src-tauri/src/`: the Tauri 2 shell. `windows.rs` (the frame swap, the close dialog and link
  interception), `scripts.rs`
  (the script runner), `commands.rs` (the UI's backend), `auth.rs` (the sign-in handoff), `update.rs` (the app
  keeping itself on the released version), `state.rs`, `setup_link.rs`.
- `scripts/stage-local-downloads.sh`: build installers from this checkout into `_site/site/public/desktop/`
  (gitignored), so the local site serves them and the web app's dev download links get your own build.
- `src-tauri/staged-scripts/`: the launcher scripts as the commit carries them (gitignored, rebuilt by
  `pnpm stage:scripts`; every `dev`, `build`, `lint:rust` and `test:rust` runs it first, because
  `tauri-build` resolves the resource glob while cargo builds).

## Release & update

The release workflow computes the version, cross-builds its Windows NSIS candidate once, and executes that file
on Windows before publication. `release-prepare.sh` then runs `_tools/scripts/build-desktop.sh` for the Linux
`deb`/`rpm`/AppImage and stages the already-tested Windows candidate beside them; it does not rebuild it.
`latest.json` and the artifacts land in `dist-bin/`, and `publish-github.sh` attaches them to the **GitHub
Release**, exactly like `intentic-sync` and `intentic-host`.

Updater artifacts are minisign-signed when `TAURI_SIGNING_PRIVATE_KEY` is set in CI (generate a pair with
`pnpm --filter @intentic/desktop-app exec tauri signer generate`; the pubkey is committed in
`tauri.conf.json`). Without it the build produces plain installers and skips `latest.json`, which is what every
release up to and including v1.213.0 did: the manifest 404s, and no copy in the wild was ever offered an
update. That skip is now **fatal for a release** and silent only at the `0.0.0` sentinel the CI and nightly
builds pass, so the same mistake fails a release instead of shipping one.

The key that pairs with the committed pubkey was **rotated** when that was fixed, the original having been
lost. An app verifies the manifest against the pubkey it was COMPILED with, so copies installed from v1.213.0
or earlier will reject every manifest this key signs and stay where they are. They need one manual reinstall —
and they are now *told* so (below), rather than retrying a signature check that can never pass again.

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is exported (empty) by `build-desktop.sh` because the signer prints
`Signing without password.` and then BLOCKS on a prompt when the variable is absent: a release that hangs
rather than one that fails.

### What the installer looks like, and the two things still wrong with it

The Windows installer is the **first artifact of this product that touches a stranger's machine**, and it is
stock NSIS: five screens and four clicks for a per-user app with no options, over MUI's default assets. Two of
its problems are worth naming because neither is cosmetic.

**It is unsigned.** Windows shows *"Windows protected your PC"* with **Don't run** as the default button for a
binary it cannot attribute to anybody, and no amount of testing retires that — SmartScreen wants an
Authenticode signature from a certificate issued to a verified legal entity. Everything to use one is already
here: `bundle.windows.signCommand` points at
[`_tools/scripts/sign-windows.sh`](../../_tools/scripts/sign-windows.sh), which signs through jsign or
osslsigncode, no-ops silently when its variables are unset, and is documented in
[`docs/windows-code-signing.md`](../../docs/windows-code-signing.md). **The only missing piece is a purchased
certificate.** Until there is one, every download ends at a scare dialog, and it is the largest single drop in
this funnel.

**The footer said somebody else's name.** MUI stamps a brand line across every page and, undefined, fills it
with its own: a first install was captioned `Nullsoft Install System v3.08-3+deb12u1` — a build toolchain the
reader has never heard of, wearing a Debian package version because this installer is cross-built on a Linux
runner, on the one screen where they are actively deciding whether to trust an unsigned binary.
`installer-hooks.nsh` defines `MUI_BRANDINGTEXT` now; Tauri includes that file ahead of everything MUI draws,
and defines the symbol nowhere itself, so this is simply the supported way to set it.

**Still open: the page count.** Tauri's NSIS config has no flag for it (`headerImage`, `sidebarImage`,
`installerIcon`, `template`, and no more), but its template already carries `SkipIfPassive` on *every* page
except the progress bar, driven by `$PassiveMode` — which is set from `/P` and nothing else. So passive mode
already **is** the one-screen install, and it is what a background update runs; only the first, double-clicked
install is loud, because a double-click passes no flags. Getting it needs `bundle.windows.nsis.template`
pointing at a vendored copy of Tauri's `installer.nsi` with `.onInit` defaulting `$PassiveMode` to 1 — a
977-line file held in lockstep with the bundler version for a one-line change, which is the same trade this
repo refuses for the connect scripts. Worth doing with a Windows runner to verify against; not worth guessing
at, since nothing in this workspace can build NSIS.

### How the app takes one ([`src/update.rs`](src-tauri/src/update.rs))

Signing the manifest is half the job; the app has to act on it. It did not. What shipped was one check at
startup, an event, and a notice reading *"Intentic X is available: it installs the next time you quit"* over a
crate with no install path in it at all — on the manager screen, which most users never open. Nothing failed,
nothing was red, and the sentence on screen is why nobody went looking.

**The shape is the one the sandbox already uses.** `ic sandbox prepare` pulls and builds the next image without
touching the running container and writes `/history/update-staged.json` to say so; `ic sandbox update` then
swaps onto what is already downloaded — seconds of downtime instead of minutes. This is that, for the shell:

```
check (20s after start, then every 6h) → download to the cache dir, silently → offer the swap → apply it
```

- **Silent by default, and applied on the way out.** A found release is downloaded and its signature verified
  with nobody asked about anything. It installs on **quit**, where there is nothing to interrupt — which means
  the next launch is simply the new version. Taking it sooner is a click, never a wait: `Ready` is the only
  state with a button on it, because by the time one is drawn the installer is already on this machine.
- **Never behind a run.** An install replaces this executable and ends the process, so it is refused outright
  while any script this app spawned is still going (`scripts::busy`) — killing somebody's four-minute
  `connect.ps1` and the window reporting it is not a trade worth making for a version bump.
- **Three surfaces, one value.** `Stage` is what the launcher notice, the tray row and the SPA's banner all
  render, so they cannot describe the same fact differently. The tray row is always there and always says
  something true (up to date · downloading 42% · restart to update), because this app spends most of its life
  as an icon with no window on screen.
- **The bytes go to disk**, under the app's own cache directory, rather than staying resident: an AppImage is
  around 100 MB and this process routinely lives for days. Nothing is traded away — the staging directory and
  the installed application belong to the same user on both platforms (`installMode: currentUser` puts the
  Windows install under `%LOCALAPPDATA%`), so anything that could tamper with a staged installer can already
  replace the app it would install over.
- **The two populations that can never update themselves are told so.** `latest.json` names exactly two
  artifacts — the AppImage and the NSIS installer — so a `.deb` or `.rpm` install has nothing of its own to be
  updated with, and the plugin left to itself would hand an AppImage to `dpkg`. And every copy from v1.213.0 or
  earlier holds the lost pubkey. Both end at a download link instead of silence: the first recognised up front
  from `bundle_type()`, the second after three consecutive failures.
- **The workspace face gets the news without gaining IPC.** The app injects `update` into the
  `__INTENTIC_DESKTOP__` marker at load and dispatches a DOM event into the page when a download finishes
  later; the page's only way back is `intentic://update`. Same one-way-then-link shape as every other action
  here.

`INTENTIC_DISABLE_UPDATE_CHECK` switches the whole of it off — the schedule, the download and the install on
exit — which is what the air-gapped installs and the executable smoke tiers rely on.

**The other half of "newest version" is the hosted SPA**, and it is not this crate's. The workspace face is
`app.intentic.dev` in a webview that is *hidden* on close rather than destroyed, deliberately, so it keeps its
session — which also means it is never reloaded and can sit on a weeks-old web build. The SPA polls its own
`build.json` and offers a reload from the same banner
([`web/src/composables/appUpdate.ts`](../web/src/composables/appUpdate.ts)). One banner, two meanings: *Restart*
in the app, *Reload* in a browser.

`POSTHOG_KEY` is the release workflow's other secret, and it is set on the desktop jobs only: a compiled app
has no entrypoint to substitute one at start the way the web image does, so it is baked into the launcher UI
here. CI and nightly builds get none, which is what keeps artifacts nobody installs out of the numbers.

## How it is tested

Nine tiers, ordered by cost. Each proves something the one before it cannot, and the split is driven by one
fact: **this app is cross-built on Linux and its Windows conventions first execute on a user's machine.**

| Tier | Runs | Proves |
| --- | --- | --- |
| `cargo test` | per PR (`desktop-check`) | the argv/env each flow assembles: for **both** hosts, since `Host` is a value rather than a `cfg!` read, so the `.ps1` named-parameter conventions are covered on a Linux runner |
| `_tools/scripts/verify-desktop-bundle.sh` | every build (called by `build-desktop.sh`) | the bundled scripts are present and byte-identical **to the ones the commit carries** (not to the working tree, which on a runner shared by six jobs can drift under a six-minute build), and the `.desktop` entry both registers `intentic://` and carries the `%u` that delivers it. Reads the deb, rpm, AppImage **and the NSIS installer**: the only automated look inside the Windows artifact |
| `_tools/scripts/verify-desktop-install.sh` | main + nightly (`desktop-verify`) | the artifacts install on a **bare** Debian, launch under Xvfb, and answer a real `xdg-open intentic://` (with the app running *and* with it closed, which are different mechanisms) see [`_tools/desktop-smoke`](../../_tools/desktop-smoke/README.md) |
| `@intentic/desktop-smoke-windows install` | desktop changes on main + every release candidate | the real NSIS installer runs on Windows; the installed app handles cold and warm OS links, renders loopback WebView content, and uninstalls while running. A release publishes the same installer bytes this tier passed |
| `_tools/scripts/verify-desktop-setup.sh` | nightly | the `connect.sh` **extracted from the installer** brings a sandbox up on a clean Docker host, hermetically (no Cloudflare, no Google, no platform) |
| `_tools/scripts/verify-desktop-update.sh` | nightly | the app **replaces itself**: two AppImages of its own at two versions, a throwaway key, a loopback release endpoint — it checks, downloads and verifies with nobody pressing anything, installs on close, and comes back on the new bytes reporting itself current. The tier that would have caught the whole of the section above |
| `@intentic/desktop-smoke-windows setup` | nightly | the installed `connect.ps1`, Windows PowerShell 5.1 conventions, Docker Desktop's Linux-container mode, and a sandbox answering health |
| `@intentic/desktop-smoke-windows agents` | nightly when the account volume exists | the host loopback route and control-token gate, followed by one real model reply read from that conversation's transcript |
| `_tools/scripts/verify-images-public.sh` | nightly | the images those scripts pull are readable **without a credential**. The only tier that runs logged out, the setup tiers carry the runner's `ghcr.io` login, so a package published private is invisible to them and surfaces first as a user's install dying at `error from registry: unauthorized` |

Run the last two locally against your own build:

```sh
pnpm --filter @intentic/desktop-app stage:downloads
bash _tools/scripts/verify-desktop-bundle.sh _site/site/public/desktop
bash _tools/scripts/verify-desktop-install.sh _site/site/public/desktop   # needs Docker
```

**Not covered:** the setup-code claim round trip, which needs a Cloudflare pool and so belongs with the gated
nightly suites. Whether every extension view renders is the browser tier's job
([`_tools/e2e/specs/extension-views.spec.ts`](../../_tools/e2e/specs/extension-views.spec.ts)): the workspace
screen is an unmodified webview onto the hosted SPA with no IPC, so that is a browser property, not a
desktop one.

## Developing it

```sh
pnpm --filter @intentic/desktop-app dev         # the app's own UI alone, in a browser
pnpm --filter @intentic/desktop-app tauri:dev   # the full app
INTENTIC_APP_URL=https://localhost:47145 pnpm --filter @intentic/desktop-app tauri:dev   # against a local web
INTENTIC_DISABLE_UPDATE_CHECK=1 pnpm --filter @intentic/desktop-app tauri:dev            # fully offline
```

**Run the Rust gate before you push.** `desktop-check` fails the whole pipeline on a formatting difference:
a round trip of several minutes to be told about whitespace: and nothing in the repo-wide `pnpm check` reads
Rust, so this is the only thing standing in front of it:

```sh
pnpm --filter @intentic/desktop-app check:rust    # exactly what desktop-check runs: fmt --check, clippy, test
pnpm --filter @intentic/desktop-app format:rust   # and this is the fix for the first of the three
```

`check:rust` is the CI job's three cargo steps in the CI job's order, so a pass here is a pass there. The
formatting step is instant and needs no build; clippy is the slow one, and only the first run pays for it.

- **Linux builds need system packages**: `webkit2gtk-4.1`, `gtk-3`, `libayatana-appindicator3`, `librsvg2`
  (dev packages), plus `patchelf` and `xdg-utils` for AppImage. In a sandbox, that is the
  `.intentic/config/environment.d/rust-tauri.Dockerfile` overlay.
- **Verifying the Windows target without a Windows box:** `cargo xwin check --target x86_64-pc-windows-msvc`
  (needs clang-cl / lld-link / llvm-rc).
- **`Cargo.lock` regenerates on the first build**: the archived one referenced a crate that no longer exists
  and was removed with it.
- The staging script self-handles the three AppImage quirks (FUSE, RELR stripping, builtin-loaders
  gdk-pixbuf); its header says which and why.
