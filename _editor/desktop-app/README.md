# desktop-app

The Tauri app for Windows and Linux that opens the editor on a folder of the user's own computer from the first launch, with no account, runs sandboxes on that computer from its This device view, and shows the hosted workspace in the same window once they sign in.

```mermaid
flowchart LR
    spa["Workspace face<br/>hosted editor, no IPC"] -->|"intentic:// navigation"| app(["desktop-app<br/>Rust shell"])
    os["OS link handler<br/>browser, second launch"] -->|"intentic://"| app
    local["Local windows<br/>the editor's shell on a folder:<br/>the main one, each folder's"] -->|"Tauri commands:<br/>places, This device"| app
    local -->|"intentic://window, local"| app
    local -->|"HTTP on loopback, token"| files["intentic-files<br/>sidecar"]
    app -->|"stdin: grants, answers"| files
    files -->|"stdout: asks"| app
    app -->|"spawns"| scripts["Staged scripts<br/>connect, sync, recreate"]
    app -->|"sync changes, bring-back"| machine(["intentic-machine"])
    app -->|"list --json, sandbox fix"| ic(["ic"])
    scripts --> ic
    ic --> docker["Docker<br/>sandbox + tunnel"]
    app -->|"sign-in"| browser["Default browser"]
    app -->|"updater"| release["GitHub release<br/>latest.json"]
```

- **One window, two faces.** The main local window (label `home`) and the workspace face swap in one frame
  (`swap_in`, `take_frame`): the one coming up takes the place, size and maximised state of the one going, so the
  reader sees one window changing what it shows. The workspace face loads the hosted [web](../web) editor from
  `https://app.intentic.dev` (or the `appUrl` setting, or `INTENTIC_APP_URL`) as remote content with no IPC. The main
  window is the local face: the same editor built into this package's bundle (`dist/files/`, `local/main.ts`), on a
  folder of this computer. A panel the editor floats out gets a frameless window of its own. This package's own `src/`
  bundle (`index.html`) now draws one thing, the close question (`CloseConfirm.vue`).
- **No internet: this computer's own sandboxes** (2026-10-16, `src-tauri/src/machine_face.rs`, `local/sandbox.ts`).
  When the workspace's address does not answer, the workspace window shows the sandbox face instead of WebKitGTK's
  error page: the same editor built into this bundle (`files/sandbox`, `dist/files/sandbox.html`), whole (every route
  and extension, unlike the folder face), on the sandboxes `ic sandbox list --json` lists here. Its platform questions
  are answered in the page (`local/machineFace.ts`): who is signed in is the account `roster.json` names, the list is
  each sandbox with a loopback port, at `http://127.0.0.1:<localPort>` and keyed by the platform's id for it (or
  `machine-<id>` before one is known), and anything else of the platform answers in plain words that it needs the
  internet. Each running sandbox is opened with a session the machine minted for its owner (`ic sandbox session`,
  kept in the app's memory only), written where the editor's sandbox client reads one; a sandbox that wakes later, or
  whose daemon refuses its session, gets one minted again and handed over on the editor's own session channel. The
  daemon admits the face's origin on the loopback port alone (the sandbox daemon's README). The page is granted
  `machine_face`, `machine_face_renew` and `machine_face_online` (`capabilities/machine-face.json`) as local content
  in the workspace window, which the hosted editor in the same window never is. Every 30 s it asks whether the
  workspace answers again and then offers it ("You're back online"), never taking the page away. On Linux (so on
  Intentic OS) `offline.rs` decides: a load of the workspace that fails for a network reason (WebKitGTK's
  `load-failed`), or a 4 s probe at the start that finds nothing answering while nothing has started to show, sends the
  window to the face on a computer that hosts sandboxes, else to `offline.html`, which also offers the face. On Windows
  the offline page offers it after WebView2 says a load failed. Not yet: an agent's preview site on the loopback port
  (netd routes preview hosts there, the editor does not dial them yet), and a panel floated out of the face.
- **The main window.** The editor's shell with the sandbox shell's rail, holding what needs no sandbox and no
  account: at the top the place chip (the folder this window shows, and the account's sandboxes, each opening the
  workspace on itself at `/?sandbox=<id>` and picked from anywhere in the window by Alt+1–9 as in the workspace, or
  the sign-in before an account), then Files (the folder's tree and documents, `/workspace`), then This device
  (`/device`), and at the foot the sandbox shell's own account control (who is signed in, Settings, Sign out), or the
  sign-in in the default browser until there is an account. The **first task** the reader writes on This device's card
  for this PC (below) is kept in `first-task.json` under the app config dir, announced on `desktop://first-task`,
  attached to this computer's sandbox when it is ready, and opened in the workspace with `?task=`; the workspace answers
  on `intentic://first-task?do=sent|failed&id=…`. "Ask about this" while no sandbox can answer leaves a draft of one
  (`first_task.rs` `prefill_from_ask`: announced on `desktop://first-task-draft`, and kept in memory for a main window
  still being built, which takes it with `first_task_take_draft`) and opens This device on it. Settings open in the window itself (`#/settings`), and
  signing out leaves it on its folder. The sandboxes and the account are what the workspace last told the app: its
  switcher hands them over on `intentic://roster` whenever either changes, a sign-out empties them, and the app keeps
  them in `roster.json` (`local_roster`), with no address, token or logo, so a row carries a name, where it runs and
  whether it is shared, and no count or state, and the account an address, a name and an `https` avatar. Before the
  workspace has said, the row is the workspace itself; the account menu shows the named account at once and then
  what the platform answers (below). It opens on the folder it was last
  pointed at (`home-folder.json`), or on `~/intentic/local`, which a first launch creates: nothing is asked before the
  first screen. A folder picked in the system's dialog from an empty folder's page, or one of the folders that page
  offers (below), takes the window's place
  (`local_pick`, then `point`: a grant of its own, and the new face handed to the page as `intentic:repoint`). The page
  moves to the folder in place, with no reload (the web's `local/folderSwitch.ts`): to the editor a folder is one
  sandbox, `local-<id>`, so the move is the editor's own sandbox switch, the rail stays put, and the old folder's page is
  held until the new one has drawn its files, then crossfades into it. The old grant is revoked ten seconds later, once
  what the page had in flight on it has finished. A page that does not take the event (still booting) is reloaded onto
  the new face at `#/workspace`. A folder another window already shows raises that window instead. Other folders and documents open
  from the tray, each in a window of its own. The main window's ×, like the workspace's, is a question and a hide (`request_close`), so nothing it holds
  is lost and the tray brings it back as it was. The shell's routes ride the page's hash (`files/local#/device`),
  since the asset protocol answers `files/local` with the local page and an address below it with the bundle's other
  page.
- **What this computer already uses.** `found_on_machine` (`src-tauri/src/found.rs`) reads what the AI tools and
  editors on this computer say about it, so a first launch can offer that instead of an empty folder and a blank
  sign-in. It reads this computer's home and, on Windows, the home of every WSL distro that is running (through
  `\\wsl.localhost`; a stopped distro is never started for it). Two things come back. The subscriptions signed in here
  (Claude Code, Codex in ChatGPT mode, Gemini CLI, and the logins opencode, Hermes and OpenClaw hold), each named by its
  account's email and plan and never by a token: the sandbox signs in to each on its own from Connect, because these
  logins renew with single-use refresh tokens and a copy would log one side out. And the folders the tools' histories
  name (Claude Code's sessions and trusted folders, Codex's trusted projects and sessions, the VS Code family's last
  windows, JetBrains' recent projects), newest first, at most twelve. Folders that are gone, someone's whole home, the
  system's, Intentic's own (`~/intentic`) and a folder that only holds other found ones (unless it is a repository
  itself) are dropped. The reading is kept for two
  minutes. The main window's empty folder offers those folders under its own recents (the web's
  `local/LocalEmptyFolder.vue`, opened with `point`), the rail's sign-in tile names the subscriptions, and the addresses a sandbox is first met
  at (a `/setup` page the app opens, and a folder's own sandbox opened on its folder) carry their ids as
  `found=claude,codex` (`with_found`, read from the last reading so a window is never kept waiting on the disk), so the
  new sandbox's Connect offers them. Nothing found leaves the computer
  except those ids.
- **The OS shell.** Linux kiosk sessions use `src-tauri/src/shell/`: sway's IPC over `$SWAYSOCK`, through the
  framing `ic`'s screen service shares (`_sandbox/ic/sway-ipc`), subscribes to sway’s bindings, workspace focus and
  windows. Super+1–9 opens the account’s roster in order, Super+0 This computer; the visible face moves
  into that Space. Sandbox windows are matched only by sway’s `sandbox_engine=dev.intentic.sandbox` and the attested
  `sandbox_app_id` (the security context’s app id), then the slug’s `ic sandbox list --json` platform id. Unknown ids stay where they opened. Holding those
  windows to their rules (never fullscreen, closed once their sandbox may not draw) is `ic os screen serve`’s, which
  hands out the sockets; This computer’s Sandbox windows card (`device/intenticOs/screen/SandboxWindowsCard.vue`,
  `shell/screen.rs`) is where the owner lets each sandbox draw, and every one is off until they do. Roster handovers also emit `desktop://roster` to the windows and rename occupied
  Spaces. Super+Space uses `/chat?sandbox=<id>&shellChat=<nonce>` to reveal an empty draft and focus its message box;
  the query is consumed once and sends no message. External `intentic://shell?open=device` and
  `?open=sandbox&id=<id>&at=agents` links only navigate, and a sandbox must still belong to the stored roster.
  The desktop edition’s Security card calls `ic os lock` through local-only commands; PINs travel on stdin, and
  settings store no PIN. The machine agent’s lock tools are separate from this shell.
- **This device.** A view this app adds to the local shell (`src/host.ts`, the web's
  `app/environments/localHost.ts`), titled This computer on screen, the name the workspace's switcher, the tray and the
  place chip give this machine (this page and the code keep This device as the view's name), where the launcher's card
  used to be: this computer's sandboxes with every verb the
  workspace's Devices tab has for them (start, stop, restart, update, rollback, resources, logs, remove), its machine
  agent and its Restart, the Docker engine they run in, and the app's own work here, which leads the page while it runs: a
  setup handed over from the workspace, with its requirements and its plan, and a sync enrollment. Above them stands
  this computer's own sandbox (below), once there is an account or a folder waiting for one: its state, the press that
  moves it on, the requirements its setup stopped on and the folders on their way into it. Its state is a store
  (`src/device/useDevice.ts`) rather than the page's, so a setup keeps running and reporting while the reader is on
  their files, and the rail's tile carries it (`src/device/badge.ts`: the running mark for a setup, this computer's
  sandbox being made or a Docker start, a warning mark for one that stopped for the reader, a dot for an update). A computer that runs no sandbox is told what
  one is for and offered the way to one, and nothing about Docker. Only the main window takes the work the app parks
  for its face (a setup, a recreate, a sync, a sleeping engine); every local window draws the same view and runs its
  verbs. The machine is read when the page opens and every 30 seconds while it is on screen.

  On Windows the one Docker engine serves Windows and every WSL distro, and `ic` on either side lists every sandbox on
  it. A sandbox the other side keeps (`keptElsewhere` in `ic sandbox list --json`, named by its distro where `ic`
  stamps one, `keptElsewhereName` or `linux/<distro>`) keeps its verbs here, since a person's start, stop and restart reach it from either side, and
  says under its row where it is kept: "Kept by WSL (archlinux)". The machine agents of this computer's environments are
  read off their files (`src-tauri/src/agents.rs`: this app's own home, and through `\\wsl.localhost` each distro that
  is running, never one that is stopped): their binary, their pidfile and `ic`. This device names the other environments
  whose agent runs under its own agent's group, and so does the tray's agent row ("Machine agent: … · also in WSL
  (archlinux)", or "Machine agent: in WSL (archlinux)" where Windows has none). _(2026-10-05) The app read the Windows
  home alone: blind to a WSL agent, it drew WSL's sandboxes as its own, and its setup put a second agent beside it._

  A listing proves when this machine hosts no sandbox any more: `ic` answered with no row of this side's own, `ic`'s
  trash holds nothing a restore could bring back (its `intentic-trashed-*` volumes), and this computer's own sandbox is
  not one the app is making or keeps. Then `hosts-sandboxes.json` is cleared, and a launch stops starting Docker Desktop
  for one (`state.rs` `forgets_hosting`). A listing that failed, or a trash that could not be read, clears nothing.
  _(2026-10-05) It was written once and never cleared, so every launch after the last sandbox was removed still started
  Docker Desktop._
- **The account in a local window.** Who is signed in, the plan, API tokens and the data export, as the account menu
  and Settings ask for them. The page cannot hold the platform's session (an HttpOnly cookie on the API's host, which
  the platform answers only from the workspace's origin), but every window of the app shares one browser profile, so
  the cookie the workspace's sign-in set is in the store a local window's webview reads. `account_relay`
  (`src-tauri/src/account.rs`) reads it there, sends the call with the workspace's origin (Better Auth's check on an
  auth call that changes something), and writes back whatever cookie the answer sets, so the session rolls forward.
  Only a short list may be asked, checked in Rust: `get-session`, `update-user`, `sign-out`, the hosted plan and
  its checkout and portal, the tokens, and `me/export`. Deleting the account is not on it, since it must first take
  the account's access off every sandbox's daemon, and a local window knows only its own folder. A sign-out also
  deletes the session from the store, empties `roster.json` and reloads the workspace window, so both faces are signed
  out together. In the page, `src/account.ts` asks for the account (the host's `account`, `updateAccount`,
  `signOut`) and `local/platform.ts` routes the plan, token and export calls of the editor's API client; who is
  signed in for the page's own session check stays the folder's placeholder, so a platform out of reach never holds
  the first paint.
- **The workspace, opened somewhere.** A press that opens the workspace at a path (a sandbox on the place chip,
  deleting the account from a local window's Settings) swaps the workspace into the main window's frame and, when its page is already loaded, tells
  that page the path instead of loading it again (`open_in_place` in `windows.rs`): a script the app runs in the page
  calls the opener the page registered (`__INTENTIC_OPEN__`, the web's `installDesktopOpener`), which selects the
  sandbox the path names and routes there in place. A page that registered none, from another origin or still
  loading, is loaded at the address, as before the opener existed. The press comes from a window, and the workspace
  comes up in that window's place (`workspace_open`, `show_workspace_from`): in the main window it is the usual swap
  of the two faces; in a folder or document window (`files-<n>`, the window `intentic .` opens) it takes that window's
  frame, and the folder window is hidden and closed. Unsaved edits hold that close as they hold any other, so the
  window comes back in front with its page's question. _(2026-10-16) The workspace always took the main window's frame,
  so a sandbox picked in a window `intentic .` had opened came up as a second window beside it, and the workspace's ×,
  answered "Quit", closed both._
- **Native work is the public scripts.** Setup, sync and everything done to a sandbox run the same `connect`,
  `sync` and `recreate` scripts the copy-paste one-liners run. `stage-desktop-scripts.sh` copies them from
  `_site/site/public/scripts` at the current commit, so an uncommitted script edit does not reach `tauri dev` or a
  local installer. Each run is told this build's own release (`IC_URL`, `IC_VERSION`), and a shim fetches `ic` only
  when the installed one is older than that: the pin is a floor, compared as a version (major.minor.patch, a pre-release
  below its release), never a ceiling. The installer carries that release's `ic` beside the app as `intentic-ic` /
  `intentic-ic.exe` (the second `externalBin`; never `ic`, which the deb and rpm would put on every PATH as
  `/usr/bin/ic`, ahead of the `ic` the machine agent keeps current), each run is told where (`INTENTIC_IC_PATH`,
  `commands.rs` `app_env`), and a shim that has to install `ic` copies that file to `~/.intentic/ic/bin/ic` instead
  of downloading it, when it answers `--version` with
  exactly the pinned release; otherwise it downloads as before, so installing `ic` does not need github.com. A build
  that pins nothing (`0.0.0`) always downloads.

  A run's child writes its two streams to two files beside its transcript (`~/.intentic/logs/desktop-<run>-<stamp>.out`
  and `.err`, `scripts.rs` `Spool`), which the app reads back as they grow for the window and the transcript
  (`desktop-<run>-<stamp>.log`, both streams, stderr lines marked `! `). A run followed to its end leaves only its
  transcript. The logs folder keeps the newest 30 runs' files, counted at launch and after every run; `ic`'s own logs
  there are not counted.

  _(2026-10-05) The shims used to fetch `ic` whenever the installed one was not exactly the app's pin, and the machine
  agent moves `ic` up by itself, so an app left in the tray for days put an older `ic` back on every Start, Stop or
  Restart. A run's child used to write to a pipe the app held: a Quit mid-run broke it, and `ic`, which prints with
  `println!`, panicked on the broken pipe half way through a recreate or a removal; now it finishes, and its files are the
  record of the rest, which its transcript names. The transcripts used to be kept for good._
- **A Windows setup across restarts.** A setup that needs Windows to end the session (exit 4) is parked in
  `resume-setup.json` with the time its code was minted (the link's arrival, since a link does not say), and the
  `HKCU\…\CurrentVersion\Run` value `IntenticResumeSetup` starts the app at the next sign-in with `--resume-setup`
  (`src-tauri/src/resume.rs`). Windows keeps a Run value until the app takes it away: when that setup's run ends,
  however it ends, when the setup is given up, and at any launch that finds nothing parked (this PC's own setup parked
  for a restart that has not come yet counts as parked, below). So a launch that crashed
  gets another, and a finished setup never starts the app again. A resumed setup whose code is older than 20 minutes
  runs on a fresh code the app mints itself with the workspace's session (`setup_fresh_code`, as for this computer's
  own sandbox), and so does a run whose claim the platform refused as invalid or expired. The card says the code ran
  out, with the way to a fresh one, only when none can be had. A run with consent on a Windows machine whose Docker is
  not listening yet also starts `ic image prefetch` (`src-tauri/src/prefetch.rs`): the `ic` beside the app, else
  `~/.intentic/ic/bin/ic.exe`, with no window, one at a time, logging to `~/.intentic/logs/prefetch-<stamp>.log`, and
  left running when the setup ends. The sandbox image downloads while Docker is installed, and `ic sandbox connect`
  loads it instead of pulling. This device reports each step's and each requirement's time
  (`desktop_install_step`, `desktop_install_requirement`, `src/device/installTelemetry.ts`) and a failed run's last
  error line, scrubbed of the home folder, the account, addresses and the code (`desktop_install_finished.reason`).

  _(2026-10-08) The entry was a RunOnce value, which Windows deletes before the launch it makes, and a resumed setup
  never got a new code: two restarts outlast a code's thirty minutes, and "Try again" ran the dead one again._
- **What runs is `ic`'s to say.** This device's list is `ic sandbox list --json` from the installed `ic` (the shim's
  `--list` when that one is missing or older than this app, whose fetch brings it level). Start, stop and restart are
  `recreate --start|--stop|--restart`, and the Resources form's Apply and Save are `recreate --shape`, all `ic` verbs
  behind the shim's switch, so a Restart here applies a shape saved for the next restart exactly as a Restart from
  the web does. Remove is `recreate --remove`, `ic sandbox remove -y`: the sandbox goes into `ic`'s trash, and its
  `/work` and `/history` stay recoverable for a week (`ic sandbox restore`), as they do from every other door. The
  confirmation says so, in place of the kit's "cannot be undone". The app reads nothing off `docker inspect`; the
  short children it waits on (Docker probes, the listing, the agent's status) share `ic`'s time-limited capture
  crate, `_sandbox/ic/bounded`, and read docker's refusals and find Docker Desktop with `ic`'s own readings,
  `_sandbox/ic/docker-host`: an engine that answers every request with an error stops a start's wait after 20 seconds
  as `broken` (quit Docker Desktop and open it again) instead of running out the five minutes as `tookTooLong`, and
  a Docker Desktop installed per user or in a folder of its own is found where `ic`'s probe finds it. A removal also has this machine's sync let go of the sandbox: `intentic-machine sync
  forget <slug>`, or, from an agent older than that verb, `sync uninstall --sandbox <id>` with the platform id this app
  remembers for the slug. _(2026-10-05) A removal used to forget only the sandbox's display name, and the agent went on
  syncing its folder until a new sandbox was made for that same folder._
- **Fixing a sandbox the workspace cannot reach.** The workspace's recovery panel sends `intentic://fix?slug=…`; the
  app brings This device forward in the main window, and it runs `ic sandbox fix <slug> [--code <code>] --source app
  --json` with the installed `ic`, looked for where This device's listing looks, with no console window, one run at a
  time and never beside another run of the app's on this machine, stopped with everything it started after ten minutes
  (`src-tauri/src/fix.rs`). A second link while one runs brings that run forward. The card at the top of This device
  is built from `ic`'s `intentic-fix:` progress lines and its final report (`src/fixReport.ts`, `src/device/fix.ts`):
  what `ic` is doing now, every check with its state and, for one that warns or fails, the problem and the remedy,
  then the outcome and what the exit code leaves (3: a yes nobody could give in a terminal; 4: a restart or sign-out).
  Each check whose fix waits on consent becomes a button that runs the fix again with `--accept <that check>` and no
  code. An `ic` that ends without a report, one from before `sandbox fix`, is said to be unable to fix yet, with
  setting the sandbox up again as the way to update it, and nothing retries. While it runs, the rail's This device
  tile spins for a reader who went back to their files. `ic` posts every run to the platform itself; the app never
  talks to the platform about it.
- **Waking a sandbox asleep on this computer at once.** A page that finds its sandbox asleep asks the platform to
  wake it, and the machine agent here collects such requests on its own poll, every fifteen seconds while anything
  sleeps. The workspace page then sends `intentic://sandbox-wakes`, and the app runs `ic sandbox wakes --json
  --source app` right away, the agent's own command, on a thread of its own with no window and a five-minute limit
  (`src-tauri/src/sandbox_wakes.rs`). The link carries nothing and is heard only from the app's own windows: `ic`
  starts only what the platform says somebody asked for. Links that land while one collection runs make one more after
  it. The init script's `sandboxWakes: true` is what tells the page to send it; an older app is sent nothing, and the
  keeper's poll wakes the sandbox as before. _(2026-10-15) Opening the app on a sleeping sandbox waited out that poll
  on top of the start and the boot._
- **Tray-resident.** The × of either face hides it into the tray, once the first × has asked whether that is what
  closing should do (`close-action.json`, "Keep Intentic in the tray" or "Quit Intentic"). While a folder or document
  window is on screen beside it, a face's × hides that face alone and asks nothing, since the app is not closing
  (`face_close`); with "Quit" chosen, the app ends when the reader closes its last window on screen, a folder window's ×
  included (`quit_with_last_window`). _(2026-10-16) "Quit" ended the app from any face's ×, taking every folder window
  open beside it down too._ The tray's "Open Intentic"
  opens the last face, "This computer" the main window, "Open workspace" appears once an account has been seen, then
  "Open a folder…" and "Open a file…" (each in a window of its own), the wake word's two rows once there is an account
  (below), the machine agent's row (This device), the update row, "Start Intentic at login" and Quit. Updates download
  in the background and install on quit or from the editor's banner or This device;
  setup and project operations hold an install, while the resumable onboarding downloads pause before it and resume
  on the next launch (or when the install fails). The update smoke checks both the installed bytes and the restarted
  app's native version, so an old window still on screen cannot count as a successful update.
  deb and rpm installs cannot replace themselves and link to the download page instead. A local window never draws the
  editor's update banner: This device says it instead. A deb or rpm upgraded under the running app (the file at the path
  it started from is no longer the one it runs, `update.rs` `replaced_on_disk`) is offered as a restart onto it ("Restart
  to use the new Intentic"), at every check and whenever the workspace comes back on screen. _(2026-10-05) A deb and an
  rpm have no maintainer script that restarts the app, so the old app and its file server ran on until Quit, and the next
  check offered the release the package manager had just installed, as a download._
- **What needs the reader, with the window out of sight.** The workspace's page decides, the app only puts it up:
  the tab's mark (the web's `shell/browser-tab/`: a count of what needs you, a check for a turn that finished while
  you were away, a dot while agents work, grey while the sandbox is not answering) on the tray icon, with its meaning
  in the tray's tooltip, as the overlay on the Windows taskbar button of whichever face is up, and as a count on a
  Linux dock that draws one (the `com.canonical.Unity.LauncherEntry` signal, sent by the app itself since tao's
  speaks only while Unity runs) (`src-tauri/src/badge.rs`, `intentic://badge`). The page draws both images with the
  tab icon's own drawing. And the same news the chimes ring for, as the system's notifications (a toast on Windows,
  the desktop's `org.freedesktop.Notifications` on Linux, `src-tauri/src/notice.rs`, `intentic://notice`): one when
  an agent needs you and one when a turn somebody started finishes, only while no window of the app has the focus,
  a burst of more than three as one that counts them, on by default with a switch each in Settings ▸ Notifications.
  Each makes the system's own sound, so Do Not Disturb and Focus assist silence it like any other app's, the first of
  a burst only and never twice within four seconds, and none when the page rings its chime for it. An ask answered
  elsewhere takes its notification down, and all of them go the moment the reader is back in the app, and when it
  quits. A press opens the workspace at the conversation: on Windows the toast's protocol activation hands the app
  `intentic://notice?do=open&token=…` through the OS, which works from the notification centre and needs no COM
  activator; on Linux it is the server's `ActionInvoked`. The token is minted per notification and means nothing
  outside the run. The toasts go out under the app's id, which the installer puts on the Start menu shortcut
  (tauri-bundler's `SetLnkAppUserModelId`), or PowerShell's for a copy run from the build tree.

  A system with notifications switched off drops every one without a word, so Settings ▸ Notifications asks the app
  (`notice?do=status`) and says where to switch them on: Windows answers per app (`ToastNotifier.Setting`), a Linux
  desktop only whether a notification service answers.

  The app also tells each page window whether it is on screen (`intentic-desktop-shown`, `src-tauri/src/shown.rs`):
  WebView2 keeps `document.visibilityState` at `visible` for a window hidden in the tray or minimised (`webview_sync.rs`
  says why the app does not change that), so the page reported its reader present all day, and the sandbox held back
  every push to their phone while the app sat in the tray.

  _(2026-10-02) Rejected as overkill: flashing the taskbar button or a dock's "urgent" state for an ask, which repeat
  what the mark already shows and do it again each time; the taskbar's progress bar while agents work; a notification
  while the reader is in the app, where the board and the mark already show it; and notify-rust, which would bring a
  second `windows` and its own toast wrapper for the two calls the app makes itself on the `windows` and `zbus` crates
  already in its graph._
- **The wake word, with the window in the tray** (`src-tauri/src/wake.rs`, 2026-10-13). The workspace's page can listen
  on the microphone for a wake word ("Leon" unless the reader named another) and does all of it itself: the microphone,
  the audio worklet, the transcription. The app's part is to keep that page where it can go on listening, and to say in
  the tray what it is doing. Only the workspace face is told `wake: true` (`window.__INTENTIC_DESKTOP__`), and only
  there does the page offer to listen. Its microphone is granted with no prompt, to the app's own origin and nothing
  else (`microphone.rs`): on Windows through WebView2's `PermissionRequested`, for that request alone and never saved in
  the profile every window shares; on Linux by turning on WebKitGTK's media stream setting for that webview and allowing
  a request for the microphone alone. Every Windows webview runs with `--autoplay-policy=no-user-gesture-required`
  (`BROWSER_ARGS`, which every webview must share), so the page's audio starts again after a reload with nobody there to
  click. The page says what it is doing on `intentic://wake` and is told what to do with `intentic-desktop-wake` (the
  tables below). In the tray, "Listen for “Leon”" is ticked while listening is wanted, and under it "Pause listening for
  1 hour", "Resume listening" while paused, or "Click to resume listening", which brings the workspace up when the
  browser holds the audio until a click. Both rows come with "Open workspace", once there is an account. The × hides
  the workspace as it always has, so the listening goes on in the tray. Whether it is wanted, and the word, are kept in
  `wake.json`, and a launch that finds it on loads the workspace hidden: nothing on screen, nothing focused, and the
  last face left as it was (`windows.rs` `load_workspace_hidden`). On Linux WebKitGTK holds a `getUserMedia` made while
  the window is off screen, unanswered, until the window is shown, so a page loaded hidden starts listening the first
  time the reader opens it ("Click to resume listening" is the way there when the page reports `blocked`); listening
  that began on screen goes on after the ×. Measured on WebKitGTK 2.54 with its mock microphone, 2026-10-13: the
  request answered the moment the window came up, and after the × the track stayed live and the audio kept arriving.
  WebView2 leaves the page visible in a hidden window (`webview_sync.rs`), so Windows has no such wait. The deb and rpm
  recommend the GStreamer plugins WebKitGTK records the microphone through (PipeWire's, PulseAudio's, plugins-good), as
  recommends rather than depends, since a desktop without them only loses the wake word.

  "Start Intentic at login" in the tray (`autostart.rs`) is off until ticked. On Windows it is the `HKCU\…\Run` value
  `Intentic`, which the uninstaller takes away; on Linux an XDG autostart entry,
  `~/.config/autostart/dev.intentic.desktop.desktop` (under `$XDG_CONFIG_HOME` when that is set), naming the AppImage
  itself for an AppImage. Either starts the app with `--background`: the tray and no window, except for a setup parked
  across a restart, and then the hidden workspace when its page was listening. A second launch with `--background`
  while the app runs does nothing. The row's tick is read back from the registry or the file after every press.
- **Google's sign-in runs in the default browser**, because Google refuses OAuth inside an embedded webview. The
  credential returns over `intentic://auth`, which also records that this install has an account (`account-seen.json`)
  and opens the workspace at `/desktop-auth/complete`, in the main window's place. An account that signs in by emailed
  code needs no browser: the code is typed on the app's own `/login`, since the mail's link would open the system
  browser instead. Its hand-off from the browser, when it signed in there, carries the session alone (no Google token),
  and the workspace's daemon sessions come from the platform's identity assertions.
- **The last face.** `last-face.json` (`home` or `workspace`) is the face the user was last seen choosing: every
  showing of the workspace writes `workspace`, and the main window shown on purpose (a launch into it, the tray's "This
  computer", the workspace's way back) writes `home`. An install without the file reads `workspace` if it ever showed the
  workspace (`workspace-seen.json`) and `home` otherwise. A launch opens This device for a setup parked across a Windows
  restart, then for a machine that hosts a sandbox and has no Docker engine listening (handing over to the workspace
  once the engine wakes, when the workspace is the last face), and otherwise the last face (`opening` in
  `src-tauri/src/lib.rs`). A launch at sign-in (`--background`, above) opens only the parked setup, if any. A bare
  second launch opens the last face too. `home_facts` hands the shell `accountSeen` (a
  sign-in, or the workspace ever shown), `lastFace`, `hostsSandboxes` and `homeFolder`.
- **Local windows.** The main window, and a folder or a document opened from the tray, the folder menu, a
  double-click ("Open with Intentic" on documents, folders, the space inside one and a drive root) or a second launch
  in a window of its own (`files-<n>`, `src-tauri/src/local.rs`). Each is the same shell. A document inside the folder of
  a window already open is handed to that window instead (`intentic:open`), and a path already being opened is not
  opened twice. Its file reads are answered by the `intentic-files` sidecar ([local-files](../../_devices/local-files))
  instead of a sandbox. The app starts the sidecar (with the main window, or a few seconds after a launch with recents),
  grants each window one folder by a random token on the sidecar's stdin, and revokes it when the window closes
  (`src-tauri/src/sidecar.rs`). What else a local window may do is the commands its capability names
  (`capabilities/local.json`): the shell's (its place chip, its folder menu, its account) and This device's, granted by name (`build.rs`); its links are only its
  own title bar and `local`. The documents it draws can do none of it: the page's policy runs no script but the
  bundle's own (`vite.local.config.ts`), a frame a document opens is another origin, which holds no capability, and a
  link it carries is heard only as `window` or `local`. No sandbox, account or Docker is needed to open anything. What
  fails to open is said in a native dialog in the user's words (the folder menu shows the same sentence under the row),
  and the original error goes to stderr. The folder menu is the folder's name at the head of its explorer
  (`LocalFolderMenu.vue` in [web](../web)): "Open a folder…" by the system's dialog, then the folders opened lately,
  newest first, and never a document. A folder takes the window's place (`local_point`, `local_pick`), asked about first
  when that would discard unsaved edits; Ctrl+click (Cmd+click on macOS) gives it a window of its own. The explorer's "Show in file
  manager" opens the window's folder itself, and selects an entry picked in the tree in the folder that holds it
  (`local.rs` `reveal`).

  (2026-10-07) An opened folder had no way to another one: the place chip had lost its folders (below), and the tray,
  which still opens them, is not where anyone looks from inside a window. The folders came back on the folder's own
  name, not on the chip, which stays about sandboxes. In the same change "Show in file manager" with nothing picked
  stopped revealing the folder in its parent: a project in Downloads opened Downloads with the project highlighted,
  which is not the folder the window shows. The menu offers folders only: "Open a file…" and documents among the recents
  were dropped the same day, since a document alone shows without its folder's tree and is gone once its tab closes,
  which reads as a lost file to anyone who does not know editors. The file just saved or downloaded is found in its
  folder instead, by the folder page's date grouping. A document the system hands over (Open with Intentic, a
  double-click) still opens in a window of its own, and so does the tray's "Open a file…".

  (2026-10-03) The local window's account menu became the sandbox shell's own (Settings and Sign out), and its Settings
  open in the window, where they used to swap in the workspace on whichever sandbox was last open. The account's calls
  ride the app (`account_relay`) rather than the page, for the reason below: the page still holds no session and
  reaches no platform. Opening the workspace's own Settings, or a Settings in the window with every account section
  read-only, were rejected: the first is the face swap the reader asked to lose, and the second leaves Profile, the one
  section they came for, unusable. The place chip lost "On this computer" (the folder, its recents, Open folder…/Open
  file… and This device's cog): the window already shows its folder, the rail already holds This device, and the tray
  opens the rest, so the chip lists the sandboxes, as the workspace's switcher lists only this computer.

  (2026-10-01) The sandboxes joined the place chip, where "Your workspace" alone stood for them: a reader on this
  computer took two presses and a face swap to reach the sandbox they meant, while the workspace's switcher reached
  this computer in one. The local window cannot list them itself (its page reaches only loopback and the app, and the
  app holds no session), so the workspace tells the app. Giving the local page a platform session and the platform
  in its policy was rejected: that page draws documents nobody vouched for. With them came the rest of the sandbox
  shell's shape: the same digits for the same places in both windows (Alt+0 this computer, Alt+1–9 the sandboxes),
  the account at the rail's foot where the way to agents was (that way is the place chip now), one name for this
  machine on screen, and a switch that does not reload the workspace. Renaming the view This computer everywhere
  was rejected: the workspace's Devices tab says "This device" of a paired machine, a different thing.

  (2026-09-30) The launcher window is gone. It was a card of its own design between the reader and everything else:
  Home (open a folder or a file, recents, sign-in), This device (Docker, the agent, sandboxes), and a handed-over setup,
  none of it in the editor's shell, and a first launch without an account opened on it. The main window replaced it,
  so every window of the app is the editor's shell from the first launch, and This device became a view of that shell.
  The local windows were granted the commands to draw it. The alternative, keeping them capability-less and asking the
  app for This device by `intentic://` links answered with events, was rejected: a link is a navigation any document
  can make on a click, while a command needs script, which the page's policy lets only the bundle run.
- **The warm window.** After the first folder or document window of a run (never for the main window alone, which
  most runs never go past), the app keeps one hidden spare files window whose page
  has loaded the editor and waits for its face: the next open, once that page has finished loading, registers its
  grant under the spare's label, hands it the face (`window.__INTENTIC_LOCAL__`, then `intentic:face`), sizes, places
  and shows it, and builds the next spare. A spare still loading is left for the open after. The spare goes after
  five minutes with no local window open. `INTENTIC_WARM_WINDOW=0` turns it off. A window's face is kept in its own
  session storage for its reloads, which is also how a sidecar that had to restart on another port moves every window
  to it (each is reloaded onto its new `daemonUrl` and token).
- **Unsaved changes.** A local window's page says whether it holds unsaved changes (`window?do=dirty`); a page
  starting in the window clears what the one before it said, and says it again once it mounts. A close of a dirty
  window, whoever asks for it, is held: the window comes to the front and its page hears `intentic:close-requested`,
  then saves or answers `window?do=close&confirmed=1`. The question is handed over by an `eval` whose completion is
  the page's receipt, so a page that has died or hung is seen not to take it: three seconds later, or at a second
  close, the app asks in its place ("Discard unsaved changes?" / "Close anyway"). Quit, the ×'s "Quit" and a restart
  with dirty windows ask first in a native dialog ("Quit anyway" / "Cancel"), and an update refuses to install until
  they are saved or closed, asked again just before the installer runs and before the restart onto it (a restart
  held that way is what the update's offer means from then on), since the Windows installer ends the process where
  nothing can ask.

  A Quit while the app is still working on this computer (a setup handed over, a start, a recreate, a removal, a fix,
  a sync's setup, a folder's bring-back) asks too, after the unsaved windows: "Quit when it's done" waits in the tray and
  quits once nothing runs, "Quit now" quits and leaves the work to finish on its own (each run's transcript says where the
  rest of its words went), "Cancel" stays. This computer's own sandbox's setup is not asked about: a quit stops it and the
  next launch runs it again. _(2026-10-05) Quit used to ask about unsaved windows alone, and abandoned every run under
  way with a dead pipe (`windows.rs` `hold_quit`)._
- **A folder in this computer's sandbox, copy-first.** "Work on this with an agent" in a folder's window asks in the
  window's own dialog (the web's `local/LocalProject.vue`), drawn from `project_preview` (`src-tauri/src/project.rs`):
  the folder's name and path, what its first copy carries, anything to beware of (another sync service, a network
  drive, a large first copy) and how far this computer's sandbox is, or why it cannot have one (a disk, a home folder, a
  system folder, one inside or around a folder that already has a sandbox), each by kind for the page to word. Its
  picture is the folder's copy carried into the agent's house (`local/house/AgentHouse.vue`). "Work on this in this computer's
  sandbox" is `project_attach`: the folder is put in line for this computer's own sandbox under its name in `/work`
  (sandbox-contract's `projectDirNameFor`, numbered past a name another folder there has), and the press is answered at
  once, whatever the sandbox is doing; nobody signed in is sent to sign in by the same press, and the window's card says
  to finish in the browser until the app hears who signed in. Once the folder is in, the window that asked opens its
  sandbox on the folder by itself when the reader is looking at it, and otherwise keeps the "ready" card up with its
  Open. "Open this folder's sandbox" opens the workspace in that window's place, as the card's Open does, at once for
  this computer's sandbox when the app last found it running, and after `ic sandbox list` (starting it if stopped) for
  any other.

  This computer's sandbox is one sandbox the app makes once, after sign-in, in the background, and keeps
  (`src-tauri/src/machine_sandbox.rs`). A thread started at launch owns it, not a window. It reads who the workspace last
  said is signed in (`roster.json`) and whether Docker's engine answers, makes the platform row (named after the
  computer, "ada-laptop sandbox") and mints its setup code with the workspace's session (`account.rs` `platform_post`,
  fixed paths, never a page's), then runs the connect script as the run `machine-setup` with `SYNC_PROJECTS_HOST=1`: a
  sandbox with no folder of its own, whose desktop-sync step enrolls this machine as the holder of its sync token. The
  script's `intentic: [phase]` lines are read in Rust into a step and a percent. One setup runs at a time on this
  docker: a setup handed over from the workspace and this one each wait for the other. The state is
  `machine-sandbox.json`, written on every change and sent whole to every window (`desktop://machine-sandbox`, and
  `machine_sandbox_status` for a window that opens later): `signedOut`, `needsDocker` (not installed, not running, or
  turning this account away), `creating`, `waiting` (the yes, restart or sign-out a setup stopped on, exit 3 or 4),
  `ready`, `stopped`, `failed` (with its log), `interrupted`, and `gone` (its container is not on this computer). It looks again at launch, at every roster the workspace sends, at a sign-in or a sign-out, at a press,
  every 15 seconds while Docker is awaited, every minute while it is not ready and every five once it is. A quit stops a
  setup under way with everything it started; the next launch finds the record `creating`, says it was interrupted, and
  runs it again on the same row with its code minted afresh (the platform hands back the live one). The system's
  notification says once that it is ready and once each time it newly needs the reader, and nothing while a window of
  this computer has the focus, where the card says it already.

  _(2026-10-12)_ **One row per computer, called "Local".** The sandbox is named `Local` on every computer
  (`SANDBOX_NAME`): the account's switcher names the device on the row's second line, and the old "<COMPUTER> sandbox",
  numbered past one already taken, said the computer twice and read as the third of three. A sandbox named that old way
  is renamed once it is ready (`/rpc/sandbox/update`), unless the account shows a name the reader gave it. "Set it up
  again" on a sandbox that is gone runs the setup on the SAME row (`recreated`), so its volumes, keyed by the row's slug,
  bring `/work` and `/history` back if this computer still has them; only a row the platform no longer has
  (`row_gone`) makes way for a new one. A record that holds no row (its file unreadable, the app reinstalled) first takes
  up the row this computer still runs (`adoptable`: owned, not hosted, named by this app, its container listed here)
  instead of making a second. The rows earlier versions left behind are offered for removal on This device
  (`LeftoverSandboxes.vue`, `machine_sandbox_leftovers`): named the old way for this computer, not the current one, run
  nowhere here and silent for a day; removed only on the reader's press, into the platform's week-long trash.

  _(2026-10-05)_ Three changes. **One run, across launches too:** a setup run holds a lock in the app's data folder
  (`machine-setup.pid.json`: the script's pid, the start time its system gives that process, and the two files it writes
  to). A launch after a hard crash that finds the lock's process alive, with the same start time, follows that run from
  its files until it ends and then decides again, which runs the setup once more on the same row as after an interrupted
  one; it never starts a second beside it, which it used to. A lock whose process is gone, or whose pid another process
  has since, is taken over. **A row that never ran goes:** a setup that fails (a code the platform would not mint, a
  script that stopped) before it got as far as starting its container (`starting-sandbox`, from which the daemon may have
  announced itself; the record keeps `announced`) takes its row off the account (`/rpc/sandbox/delete`, into the
  platform's own trash), so a Try again makes a fresh one. A row a setup ever finished, one that may have announced, or
  one whose container is here or could not be looked for, is never discarded. Before, only a failed minting in the
  per-folder flow discarded its row, and every other failure left an unfinished sandbox in the account's switcher.
  **Checked first:** where another environment of this computer already runs a machine agent that keeps its sandboxes
  (a WSL distro's, `agents.rs`) and this one has none, the first setup is not run unasked, which would put a second agent
  and a second sandbox on the same Docker. The card says where the sandboxes are kept, and its Try again sets one up here
  all the same.

  A folder's name in `/work` is its own (`projectDirNameFor`), or, when another folder already has that, the first free
  of the names its parents lend it (`projectDirCandidates`: `code-app`, then `ada-code-app`), which says which one it
  is; only past those is it numbered. A folder inside one already attached is covered by it (`covering_project`): its
  window is told it has a sandbox (`partOf` names the folder it went in with), its button opens that one, and Bring back
  runs on that folder's sync, narrowed to this folder's own files; its sync direction is that folder's to change. A
  folder around one already attached, or one still in line, is refused, so no file is ever synced twice.

  Once it is ready, each folder in line is attached by the machine agent (`intentic-machine sync attach --sandbox-url
  https://<hostname> --dir <folder> --name <name> --json`, which only records the pairing), remembered in
  `projects.json` with this computer's sandbox, and every window on it hears so (`intentic:sandbox`). The app then
  follows the folder's first copy in `intentic-machine status --json` until the agent's word for its Mutagen session is
  `watching`. A paused session stays followed, with the copy card and folder button saying it is paused instead of
  showing progress; the card offers the sandbox, where Devices can resume file syncing. Every local window carries a
  card in its corner while this computer's sandbox is not ready, in the
  notification lane (the web's `local/LocalMachineCard.vue`, worded by `local/machineCard.ts`): the house goes up stage
  by stage as the setup's real phases arrive (the plans, the ground and its materials as the image arrives, the walls as
  the container starts, the roof as the daemon comes up, the lights as it answers), then the folder's copy moves in
  through the door. It says every state with the one press that moves it on (Sign in, Start Docker, This computer for
  the requirements, Try again beside the log, Start, Set it up again), folds to a line, and remembers the fold for what it
  showed in every window. The folder's button says how far it is ("Waiting for this computer's sandbox (42%)", "Copying
  your folder…") and then opens the sandbox on the folder (`/?sandbox=<id>&project=<name>`, the web's
  `router/sandboxArrival.ts`), never on the `/work` around it. This device leads with the same states and presses
  (`src/device/machineSandbox/MachineSandboxSection.vue`), and the rail's tile spins while it is made and marks it while it needs the
  reader.

  The folder is copied into the sandbox's `/work/<name>` and kept up to date from here; agents change the copy, and
  nothing in the folder changes until the window's "Bring back changes", which keeps a restore point first. The window
  asks `changes` on its own once the folder's first copy is done, and again when the reader comes back to it (at most
  once a minute), and draws Bring back only when the sandbox holds something to bring back. A folder
  that already has a sandbox of its own, made for it alone before this, keeps opening that one. The workspace's own
  `/setup?project=<name>&machine=mine` can still hand a project's setup back as `intentic://setup?…&project=<name>`, for
  the folder this app parked. A hosted sandbox's project, asked for by name, is enrolled with
  `intentic://sync?…&project=<name>&sandbox=<id>`, whose sync script runs here on the parked folder with the same three
  values (a folder is asked for in a system dialog when none is parked). Either way the folder is the window's own or
  the one this app parked (never a path on a link or a command), and `projects.json` remembers it so opening the folder
  again reaches the same sandbox; every window on the folder hears so at once (`intentic:sandbox`). A project whose
  sandbox the account no longer lists (the workspace's last roster, which a new row joins the moment it is made) is a
  folder with none: its button asks again, and putting it in line first has the machine agent let go of the dead one's
  sync of the folder (`intentic-machine sync uninstall --sandbox <id>`), since the agent keeps one sync per folder. The
  window's project verbs (`changes`, `bring-back`, `restore`, `direction`) each run the machine agent,
  `intentic-machine sync <verb> --dir <folder> … --json`, and hand its JSON object back to the window as
  `intentic:project`. The paths a bring-back is limited to go in a JSON file (`--paths-file`, in the app's cache,
  removed after the run), never on the command line, which Windows caps at 32,767 characters. One bring-back, restore
  or direction change runs per folder at a time, and an update waits for it.

  _(2026-10-05)_ A paths file older than a day is swept at launch: only a run that ended removed its own, so a crash mid
  bring-back left one naming the reader's files for good. When the workspace's roster no longer lists a sandbox (a
  roster that names who is signed in, compared with the same account's last one), the folders remembered with it leave
  `projects.json`, and this machine's sync lets go of it (`intentic-machine sync forget <slug>`, falling back to `sync
  uninstall --sandbox <id>` on an agent older than the verb), but only for a sandbox the agent syncs. This computer's own
  sandbox is left to its supervisor, which says for itself when that one is gone. Before, `projects.json` was never
  pruned, and the agent let go of a folder's dead sandbox only when a new one was made for that folder.

  (2026-10-05) Each folder used to get a sandbox of its own. The question was first the system's own message box, two
  paragraphs in its look, whose press took the reader to the workspace's full-screen `/setup` and then to This device;
  then the window's own dialog, whose press made a sandbox for that folder and ran its setup in that window's store,
  drawn as a build card over the folder. A pane beside the folder for the build was rejected (it takes the reader's
  width for a minute of watching), as was a bare toast (no room to show what is happening). The owner then chose one
  sandbox for the whole computer, made after sign-in, which every folder goes into. Its state lives in the app's Rust
  rather than a window's store because a window closes and the app quits: a setup a window ran was seen by that window
  alone, and a quit mid-setup left the folder remembered against nothing, since the dying process remembered it after
  its script. Docker is never installed or started for it unasked: a computer whose engine is off has its own reasons,
  so the reader starts it (This device, or the card), and the next look notices. Folders that already have a sandbox of
  their own keep it: it holds their agents' work and conversations, and moving them into another sandbox is a migration
  nobody asked for.
- **"Ask about this".** A local window can hand one of its files to the workspace: the app grants it to the sidecar
  read-only, for the workspace's origin alone and for fifteen minutes (a handoff grant, never a window), and opens
  the workspace at `/?handoff=<base64url of { url, token, name }>`, where `url` is the sidecar's
  `/workspace/raw?path=<name>`.
- **Uninstalling on Windows** (`src-tauri/installer-hooks.nsh`, 2026-10-18). The uninstaller ends the app and its
  file server (`intentic-files.exe`, which an install over the app ends too: a slow exit held its file), and the rest of
  Intentic goes through `ic uninstall`, run from the copy of ic the app ships beside itself (`intentic-ic.exe`), so it
  is there even where ic was never set up. Its first page asks ic what this PC holds (`ic uninstall --dry-run --ini`)
  and offers one choice: **Remove everything**, preselected (the sandboxes and runners with their data, the saved
  passwords, the intentic engine, the machine agent, folder sync, ic, caches and logs), or **Keep my sandboxes** (they
  keep running, with the engine, the agent and ic that keep them up; only the app, folder sync and caches go). With
  sandboxes on the PC, Remove everything asks once more, naming them, with No as the default; with nothing of the
  reader's own there, the page only says that everything goes. The hook then runs `intentic-ic.exe uninstall
  --without-app --yes`, with `--delete-data --confirm <n>` or `--keep-sandboxes`. A passive or silent uninstall shows
  no page and keeps the sandboxes; an update, or a reinstall (a newer setup running this uninstaller in place), calls
  no ic and keeps the shortcuts and the session; and when ic itself started the uninstaller (`INTENTIC_UNINSTALL=done`,
  the last step of `ic uninstall`) the hook leaves the rest to it. When ic is missing, cannot look or fails, the app
  still goes, the sandboxes stay, folder sync is stopped through the machine agent (`intentic-machine sync uninstall
  --folders`), and the last page says to run `ic uninstall` in a terminal; a copy with no `intentic-ic.exe` at all
  asks "Also remove the Intentic machine agent from this PC?" as before. The app's own folders
  (`%APPDATA%\dev.intentic.desktop` and `%LOCALAPPDATA%\dev.intentic.desktop`, the webview's profile with the session
  cookie in it) go on every real uninstall, "Delete app data" ticked or not; the install folder
  `%LOCALAPPDATA%\Intentic` is never deleted whole, since the engine's disk is in it. The platform's own record of the
  session is left to expire, since the uninstaller has no way to send it. The last page says what went and what stays:
  Docker Desktop, WSL and the synced folders' files are not Intentic's. _(2026-10-05 to 2026-10-18) The uninstaller
  asked about the machine agent alone, stopped folder sync, and said on its last page that the sandboxes, their data,
  the engine and `ic` stayed, with the commands that remove them. Before that it removed the app alone and said
  nothing._
- **"Open with Intentic" in Windows 11's own menu** ([explorer-menu](explorer-menu), 2026-10-07). The installer used to
  register it as classic registry verbs only, which Windows 11 shows under "Show more options" and never in its new
  menu: that menu lists only commands declared by an app package. `intentic_explorer_menu.dll`, installed beside the
  app, is such a command, on folders, the space inside one and the document types the app opens, and the installer
  hooks register the identity package that declares it (`regsvr32 /n /i:<mode>`). A release that holds the code-signing
  certificate ships that package signed and it registers silently; otherwise the first interactive install signs one
  on the PC behind one UAC prompt, which Windows labels as its own rundll32, so the progress line says first that it may
  come and what it is for. Updates and passive installs never prompt. Wherever the package is not in place
  (Windows 10, a declined prompt, a failure), the classic verb is written instead, so the entry is in one menu or the
  other and never both.
- **`intentic .` in a terminal** ([src-tauri/cli](src-tauri/cli), 2026-10-11), the way `code .` opens VS Code. The
  Windows installer puts two launchers in `$INSTDIR\bin` and that folder on the user's PATH: `intentic.cmd` for cmd and
  PowerShell, and `intentic`, a sh script that WSL (which appends the Windows PATH to its own) and Git Bash find on
  the same PATH. Each hands its paths to `intentic-desktop.exe` beside it, which opens them like any launch argument
  (`open_args`): a folder gets its window, or the window already showing it is raised. The sh script turns a Linux
  path into its Windows name first (`wslpath -w`: `~/project` becomes `\\wsl.localhost\<distro>\home\…\project`,
  `/mnt/c/x` becomes `C:\x`; `cygpath -w` in Git Bash). Both return the prompt at once and leave the app none of the
  terminal's handles: the `.cmd` starts it through PowerShell's `Start-Process`, since cmd's `start` would hand it the
  caller's redirected or captured output, and a captured `intentic .` would then wait until the app quit. cmd.exe cannot
  stand in a `\\…` folder and falls back to `C:\Windows`, so the `.cmd` refuses a relative path there and says to use
  WSL or a full path. The PATH edit is PowerShell's as well (`INTENTIC_CLI_PATH`): NSIS strings stop at 1024
  characters, and a longer user PATH read and written back by NSIS would come back cut short. Every install adds the
  entry (so an existing install gets the command with its next update) and the uninstall removes it, leaving the rest of
  the value and its registry type as they were. A terminal that was already open keeps its old PATH. When the PATH edit
  fails (on a loaded PC PowerShell can outlast its minute), the installer leaves `cli-path-pending` in the app's config
  folder and the app adds the entry itself at its next launch (`src-tauri/src/cli_path.rs`), the same way: whole
  entries, unexpanded, under the value's own type. _(2026-10-12) The failure was only a line in the install's details,
  under an install that said it completed, and the command stayed missing._ Linux gets no
  launcher: the deb and rpm put `intentic-desktop` itself on PATH, and it reads the same path arguments.
- **Intentic OS** ([src-tauri/src/os.rs](src-tauri/src/os.rs), 2026-10-13), the immutable Linux whose desktop edition
  boots into this app ([_os](../../_os/README.md)). Where `/usr/lib/intentic-os/release.json` exists, This device draws
  a This system card (`src/device/intenticOs/`): edition, version and channel from `ic os status --json`, the boot's
  health with each failed check, how sandboxes are isolated, and, with an update staged or a rollback queued, "Restart
  to update" or "Restart into the previous version", confirmed first: every sandbox restarts with the computer and its
  running turns resume after. Below that: Check for updates (and Download), Roll back, and the stable/beta channel. Every
  call runs the OS's own `/usr/bin/ic`, never the `ic` beside the app (only the OS's is sure to know `ic os`), and never
  bootc or systemctl. Changes run one at a time and stream like an engine move, each line to every window on
  `desktop://os-run`; a restart is refused while any other run of the app's is going. The sway session starts the app
  with `INTENTIC_KIOSK=1`: sway tiles both faces below its system bar, the × is refused instead of hiding the only thing on screen,
  minimise and maximise do nothing, and the app never updates itself, since the OS image carries it (nor anywhere
  release.json is present).
- **This computer's own settings on Intentic OS** ([src-tauri/src/os_settings.rs](src-tauri/src/os_settings.rs),
  2026-10-16). Under This system, a This computer heading holds five cards (`src/device/intenticOs/ThisComputer.vue`),
  each shown once `ic os` has said what it is and hidden where it says there is nothing (exit 3, not Intentic OS; exit 4,
  no screen on the server edition, for the screen and keyboard cards). Network: online by Wi-Fi (with its strength), by
  cable or not at all, Wi-Fi on and off, the networks nearby with a lock on those that want a password, Join (a locked
  network not joined before asks for its password first, and again after a wrong one, `ic os network wifi connect`
  exit 5), and Forget for one joined before. The password goes to ic on its stdin (`--password-stdin`, through
  `intentic_bounded::capture_with_input`), never on its command line. Sound: a volume slider sent once it rests,
  mute, and which speaker it plays on. Screens: each by what a person calls it (the built-in one, else its model), its
  resolution and refresh rate, and the size of text and apps (100% to 200%); a change is on trial for 15 seconds and
  goes back by itself unless the reader keeps it, since a screen that went black cannot be read to undo it. Keyboard:
  every layout by name with a box to find one, its variants, and a line to try it in. USB drives and memory cards: each
  by its label, else its model, with its size; Copy into a sandbox on this computer (into a folder the reader names, or
  a new one in Imports), its progress while it runs and a Stop, how much it copied and where, or that there was no room
  (exit 6) and nothing was copied; and Eject. The commands, one per verb, check what reaches ic's command line as the
  contract's schemas do (a drive is `/dev/…`, a folder stays inside `/work`, a screen or layout is a plain name, a
  network's name goes after `--`), and read ic's answers strictly, tested against the contract's golden examples.
  The statuses are read as the page opens and every 10 seconds while it is on screen; the Wi-Fi list (a rescan of
  seconds) as the card opens and at Look again. A thread of the app's (`os_settings::start`) asks `ic os drives list`
  every 3 seconds while the app runs on Intentic OS and tells every window when the list changes
  (`desktop://os-drives`). A drive plugged in after its first read is fresh: it gets a system notification ("USB drive
  KINGSTON plugged in", "Choose where it goes") whose press opens This device, where the Drives card is brought into
  view with the drive lit up. Once the card has been on screen a few seconds the drive is seen, and its notification is
  taken down, as it is when the drive leaves, is copied or is ejected. The notification is in the reader's language:
  each window hands the app its words as it starts and when the language changes (`os_drive_words`), and the app says
  them in English until one has. A copy runs one at a time, transcribed and stoppable like every run of the app's
  (`os-drive-import`), each progress line and its end told to every window (`desktop://os-drive-import`).
- **Deletes go to the Recycle Bin.** A delete in a local window reaches the sidecar, which asks the app (`ask`,
  `verb: trash`); the app moves the entry to the OS's Recycle Bin or Trash (the `trash` crate) when it lies strictly
  inside the folder of an open folder window, and answers.

## The link surface

`intentic://` is the only channel from the workspace's page into the app, and a local window's for its own title bar
and folder (its other verbs are Tauri commands, above). Navigations in the app's own windows are intercepted
in `windows.rs`. Links from anywhere else arrive through the OS scheme handler, which on Linux is the desktop entry
built from [src-tauri/main.desktop](src-tauri/main.desktop). [setup_link.rs](src-tauri/src/setup_link.rs) parses
every link and drops what an outside sender may not ask for. The editor builds them in
`_editor/web/src/app/environments/desktop.ts`.

| Link | Accepted from | Does |
| --- | --- | --- |
| `setup?code=…[&sandbox=…][&name=…][&syncDir=…]` | anywhere; outside asks first | This device, in the main window, runs that sandbox's setup here. `cfToken`, `platform` and `project` count only from the app. |
| `signin[?switch=1]` | anywhere | Opens platform sign-in in the default browser; `switch` asks for the account chooser. |
| `auth?handoff=…&state=…[&profile=…]` | anywhere | Completes a sign-in this app started and opens the workspace at `/desktop-auth/complete`. A sign-in pressed in a local window carries `back=agent` on that path, and the page sends `launcher?to=agent` once it is redeemed and before it opens a sandbox of its own, so a folder's "Work on this with an agent" ends on that folder rather than on the account's sandbox list. The app remembers which local window pressed it, for the way back. |
| `sync?url=…&pair=…[&name=…][&takeover=1][&mirror=1]` | app windows | Enrolls this device in desktop sync from This device; the folder is picked in a system dialog. |
| `sync?url=…&pair=…&project=<name>[&sandbox=<id>]` | app windows | A hosted sandbox's project: syncs the parked folder with `/work/<name>` and remembers it with that sandbox. |
| `recreate?slug=…[&hash=…][&rollback=1]` | app windows | Moves the sandbox to the `:stable` base, a pinned overlay, or its previous image, from This device. |
| `fix?slug=…[&code=…]` | app windows | Runs `ic sandbox fix` for that sandbox here and shows it on This device; `code` is the recovery panel's fix code, which `ic` claims so the panel follows the run. A slug or code that is not a plain token drops the link. |
| `update` | app windows | Installs the downloaded update and restarts. |
| `setup-stop?sandbox=<id>` | app windows | Stops the setup This device runs for that sandbox, as its card's Stop does, and shows nothing: the setup page sends it when the reader takes a slow download's offer of a machine of ours, which takes over the sandbox's address. A setup for another sandbox, or none running, is left alone; an id that is not a plain token drops the link. |
| `launcher[?to=files\|agent]` | app windows | Brings the main window back in the workspace's place: at This device (a setup's way back to its run, a sandbox's restart), at its folder with `to=files` (the sandbox switcher's "This computer"), or with `to=agent` at whichever of the two this computer's sandbox is standing at when the link arrives — This device while it is stopped on the reader (`Standing::wants_the_reader_after_sign_in`), otherwise the folder window the sign-in was pressed in, while the sandbox comes up by itself. Signed out counts as coming up: the link arrives before the workspace has said who signed in. An app that predates a `to` reads the bare link, which is This device. |
| `badge?mark=…[&count=…][&tooltip=…][&icon=…][&overlay=…]` | app windows | The workspace tab's mark (`none`, `asks`, `done`, `working`, `offline`) on the app's icon: `icon` for the tray and `overlay` for the Windows taskbar button, each a PNG as unpadded URL-safe base64 of at most 64 KiB and 256 pixels a side; `count` for a Linux dock, heard only with `asks`; `tooltip` after the app's name in the tray's, one line of at most 100 characters. A value out of shape drops the link. |
| `notice?do=show&key=…&kind=asks\|finished&title=…[&body=…][&path=…][&silent=1]` | app windows | Puts up one of the system's notifications, replacing the one under the same `key`. `path` is a workspace route (`/?sandbox=<id>&conversation=<id>`) a press opens, `silent` asks for no sound. `do=withdraw&key=…` takes one down, `do=clear` all of them, and `do=status` asks whether the system shows them at all (answered as `intentic-desktop-notices`). A line that is empty, too long or holds a control character, or a path that is not rooted or starts `//`, drops the link. |
| `wake?state=off\|listening\|paused\|blocked\|error&word=…[&until=…]` | the workspace window | What the workspace page's wake-word listening is doing, whenever that changes: kept for the tray's rows, and whether it is wanted (any state but `off`) and the word written to `wake.json` for the next launch. `word` is one line of 1 to 40 characters; `until` (epoch milliseconds, a positive whole number) rides only with `paused`. A value out of shape drops the link. |
| `notice?do=open&token=…` | anywhere | A press on one of the app's notifications, as Windows delivers it through the OS: the workspace at that notification's route. A token this run did not issue, letters and digits only, opens the workspace as it is. |
| `roster?list=<JSON>[&account=<JSON>]` | app windows | The account's sandboxes as the workspace's switcher lists them (`id`, `name`, `place`, `shared`) and who is signed in (`email`, `name`, `image`), kept in `roster.json` for the place chip and the rail's foot; `[]` and no account after a sign-out. One value out of shape drops the link: an id that is not a plain token, a name empty, over 200 characters or holding a control character, a place that is not a lowercase word, an account without an address, an avatar that is not an `https` address. |
| `window?do=…` | app and local windows | The editor's own title bar: `ready`, `minimize`, `maximize`, `close[&confirmed=1]`, `dirty&value=0\|1`, `drag`, `raise`, `fit`, `mode`. |
| `local?do=…` | local windows only | `open-folder` and `open-file` in the system dialog, `reveal[&path=…]` an entry of the window's own folder, `sandbox` (the folder's sandbox opened, or the window asked to put up its dialog), `ask&path=…`, and the project's `changes`, `bring-back[&paths=<JSON array>]`, `restore&point=…`, `direction&value=to-sandbox\|both`. |

A local window is heard on those two links and nothing else: never a setup, a sync, a recreate, a fix or a sign-in,
since it draws documents nobody vouched for (`Source::Files` in `setup_link.rs`). Every value a local verb carries is
held to its shape before it reaches a folder or a command line: paths are root-relative with forward slashes, never
absolute, never `..`, never starting with `-`, and never holding a `:` (a drive, `C:/x` or `C:x`, or an alternate data
stream); a `paths` that is not a non-empty JSON array of such paths, a restore point that is not a plain token, or a
direction other than the two drops the link. A project verb is answered only for a folder window whose folder is in
`projects.json`. A `sync` link naming a `project` that is not a project folder's name, or naming one beside `mirror`,
is dropped whole: read without its project it would sync the folder with the sandbox's whole `/work`.

## What the app tells pages

Nothing is returned over a link. The app answers with DOM events it dispatches into the page by `eval`, one way:

| Event | Window | Detail |
| --- | --- | --- |
| `intentic-desktop-window` | workspace, floating, local | `{ maximized }`, for the page's own maximise button. |
| `intentic-desktop-shown` | workspace, floating, main window | `{ shown }`: whether the window is visible and not minimised, on each change and once its bar is up. |
| `intentic-desktop-notices` | the window that sent `notice?do=status` | `{ setting }`: `on`, `off-user` (Windows has every app's notifications off), `off-app`, `off-policy`, `none` (no notification service answers on this Linux desktop) or `unknown`, for Settings ▸ Notifications to say beside its switches. |
| `intentic-desktop-update` | workspace | `{ version }` of a downloaded update. |
| `intentic-desktop-wake` | workspace | `{ do: "on" \| "off" \| "pause" \| "resume", minutes? }` from the tray's rows, heard only by a page of the app's origin. Said again every three seconds for up to a minute until the page reports a state that agrees, since a page still loading in the tray has no listener yet. |
| `intentic-desktop-setup` | workspace | This device's setup progress (`SetupReport`). |
| `intentic:face` | a worn spare | none: `window.__INTENTIC_LOCAL__` has just been set. |
| `intentic:repoint` | local window pointed at another folder | the folder's face, kept for the window's reloads. Cancelable: the page takes it to move in place (`local/main.ts` seeds the folder's session, the web's `local/folderSwitch.ts` moves), and a page that does not take it is reloaded onto it. |
| `intentic:open` | local folder window | `{ path }` of a document inside its folder, root-relative. |
| `intentic:close-requested` | local window | none: a close is held for unsaved changes. |
| `intentic:project` | local folder window | `{ kind: "changes" \| "brought-back" \| "restored" \| "direction", result }`, `result` being the machine agent's own `{ ok, … }`; or `{ kind: "error", verb, error }` when the agent is missing, would not start, timed out or printed no JSON, or the folder has a run under way already. |
| `intentic:navigate` | main window | `{ path }`, a route of the local shell (`/device`): the screen the app raised the window for. |
| `intentic:sandbox` | local folder windows | `{ sandbox: true }`: the window's folder has its own sandbox now (`project.rs` `remember`), kept in its face for its reloads. |
| `intentic:project-ask` | local folder window | none: put up the folder's sandbox dialog (`sandbox` asked by link for a folder with none). |
| `intentic:sandbox-opening` | local folder window that asked `sandbox` | `{ stage: "starting" \| "shown" }`: its sandbox was stopped and is being started first, or the workspace is going up (`project.rs` `open_existing`). The folder's button says "Opening" from the press until `shown`, and "Starting" in between. |
| `intentic:drop-copy` | workspace, floating (Windows) | `{ id, kind, … }` for a drop the page handed over: `received`, `declined` (`reason`), `scanning`, `copying`, `progress` and `finished`. See "A big drop" below. |

A local window also hears the app's Tauri events, which This device listens on: `desktop://run` (a script run's
`started`, `line` and `exit`), `desktop://pending-setup`, `desktop://setup-stop` (a sandbox id),
`desktop://pending-recreate`, `desktop://pending-sync`, `desktop://update`, `desktop://machine-sandbox` (this
computer's own sandbox, its whole record on every change), and on Intentic OS `desktop://os-run` (a change to the
system's `started`, each `line` and its `exit`), `desktop://os-drives` (the drives plugged in, `{ drives, fresh }`,
whenever that changes) and `desktop://os-drive-import` (a copy off a drive: `started`, `progress` with `bytes` and
`total`, and its `exit`).

## A big drop, copied by the app (2026-10-09)

A folder dropped on the workspace's explorer goes the browser's way, read and uploaded over HTTP, unless it is big and the
sandbox is on this computer. On Windows, the page posts the drop's `File`s to the app with
`chrome.webview.postMessageWithAdditionalObjects`, naming the folder they go into and the loopback port it reaches its
sandbox on. The message is a JSON string. wry's handler, which carries Tauri's IPC, hears every message first and reads
it as a string. An object makes that handler fail, and WebView2 then calls no handler after it. Tauri logs one
`console.error` in the page for the string, which is none of its calls. WebView2 hands the app each file's
place on disk (`ICoreWebView2File`).

The app (`src-tauri/src/drop_copy.rs`):

1. Finds the `intentic-sandbox-*` container that publishes that port.
2. Walks the dropped folders with the page's own skip rule, which the page sends.
3. For a drop of at least 1,000 files or 1 GiB, copies each file the way that is fastest for its size:
   - **Staged:** folders and files under 2 MB. The app reads them 16 at a time into tar archives in a folder of its own
     under the temp folder, each closed at 2,000 files, 256 MB or 2 seconds. A helper container
     (`intentic-drop-copy-<id>-stage`, the sandbox's own image, no network) mounts that folder read-only and unpacks
     each archive into the workspace volume as it is completed. At most two wait on it at once, so the copy holds
     under 1 GB of this computer's disk.
   - **Mounted:** files from 2 MB up. A second helper (`intentic-drop-copy-<id>`) mounts each dropped folder read-only
     beside the workspace volume and tars them across with 1 MiB records.
   - **Streamed:** one archive into the sandbox's own `tar -x` (`docker exec -i -u 0 <container>`), for what the
     helpers cannot take: a big file on a place that will not mount (a network share), an archive that did not
     unpack, a file a helper had trouble reading, and everything when no helper will run.
4. Counts a file done only on the word of the tar writing it into the workspace: each route's writing tar runs with
   `-v` and its complaints on the same stream, so a file is whole once tar names the next with no complaint between,
   or exits 0 after it. The mounted route's reading tar must also have read the file without complaint. Anything put
   into a pipe that tar then failed to write (a full disk) is not done.
5. Removes from the workspace any file a tar started and did not finish: a failed read (tar pads it out to its size),
   a failed write, or the file a cancel stopped it on. A failed file is missing rather than there and wrong. A file
   no tar started on is left alone, so an older copy of it stays: after a cancel, the archives the staging helper
   never opened, and the rest of the one it was on, are untouched, and what it finished stays.

Measured on omen (Docker Desktop for Windows) on 2026-10-09. Each class is about 512 MB, except the stills (164 MB).
These ran with five of the CI runner's jobs on the same Docker engine; a row from an idle engine says so.

| Files | Streamed (`docker exec -i … tar -x`) | Mounted | Staged (written / unpacked) |
| --- | --- | --- | --- |
| 20,000 × 8 KB | 40.5 s | 142.8 s | 0.7 s / 3.9 s |
| 2,000 × 256 KB | 33.3 s | 30.6 s | 2.2 s / 11.2 s |
| 256 × 2 MB | 34.8 s | 9.2 s | 1.2 s / 7.7 s |
| 64 × 8 MB | 22.2 s | 6.3 s | 1.2 s / 6.9 s |
| 1 × 1 GiB, idle | 47 s | 5.6 s | not measured |

Each unpack includes about 3 s of starting a container, which the staged route pays once. The staged writes for the
three bigger classes were made by Windows' `tar.exe` reading one file at a time; the stills' 0.7 s was the app's
reader with 16 at a time, on files already in the cache. Read one at a time, the same 20,000 stills took 72 s, about
3.6 ms a file. That, not Docker, was why the first version crawled through small files.

With six CI jobs holding 18 of the Docker VM's 26 GB, two of the mounting helper's reads failed partway with "Cannot
allocate memory". Repeated runs under the same load all landed, at every record size from 10 KiB to 1 MiB. That
failure is the reason a helper's trouble goes back through the streamed route.

The page draws the same card as an upload from the `intentic:drop-copy` events. Anything else is `declined`, and the page
uploads the drop itself: no Docker, no container on that port, a smaller drop (which keeps the upload's skipping of
unchanged files), or a file with no place on disk. The page can only name files a person dropped. The folder it names
is held to a plain relative path below `/work`. The init script's `nativeCopy: true` is what tells the page to ask, and
only Windows builds say it.

_(2026-10-09) A 30 GB folder of 66,000 films and stills, dropped from Explorer onto a local sandbox, froze the page while
it was read and never started uploading. Rejected: compressing first, since the films were already compressed and the
transfer was never the slow part; one archive streamed through Docker's API for everything, which the table above
shows is the slowest way to move a big file; `docker cp -` for the streamed route, which unpacks through Docker
Desktop's backend (20,000 stills took 170 s with six CI jobs running); and staging the big files too, which writes every
byte of a film to this computer's disk before the helper reads it again._

## The sidecar's control lines

The app writes JSON lines on `intentic-files`' stdin and reads its stdout (`_devices/local-files/src/control.ts`).
When its stdin closes it lets go of the office editor for at most 3 seconds, closing the editor's idle connections first,
and exits: _(2026-10-05)_ that close used to wait for every open connection, and kept the process, and its file, past the
app's own exit. Each spawn is a generation: a start that does not hear `ready` within 20 seconds kills its child, only the current
generation's exit restarts it, with every grant handed back on the same port, and an event the app does not know is
passed over. When that port is taken the restart takes a fresh one, and first gives every window and handoff a new
token, since whatever holds the old port hears the old tokens from pages still calling it; the windows are then
reloaded onto their new address and token.

| Line | Direction | Meaning |
| --- | --- | --- |
| `{"op":"grant","token","id","path","kind"}` | in | Serve a folder or a file for one window. |
| `{"op":"grant",…,"id":"handoff-<n>","kind":"file","readOnly":true,"origins":[…],"expiresInMs":900000}` | in | A handoff: one file, read-only, for the workspace's origin. |
| `{"op":"revoke","token"}` | in | The window closed. |
| `{"op":"answer","id","ok"[,"error"]}` | in | The answer to an `ask`. |
| `{"op":"prefetch-office"}` | in | Fetch the office editor now: once per run, after the first local window opens (the main one at launch included), never with `INTENTIC_DISABLE_UPDATE_CHECK` set. |
| `{"event":"ready","port"}`, `granted`, `refused`, `revoked` | out | Where it listens, and what it made of each grant. |
| `{"event":"ask","id","verb":"trash","path"}` | out | Move this entry to the Recycle Bin or Trash. |
| `{"event":"office","state":"ready"\|"failed"[,"error"]}` | out | Where the office editor's download went; logged. |

## Key files

- [src-tauri/src/lib.rs](src-tauri/src/lib.rs) — startup: plugins, the command list, the tray and what a launch opens onto.
- [src-tauri/src/local.rs](src-tauri/src/local.rs) — the local windows: the main one and its folder, each window's grant, pointing a window at another folder, the warm window, handoffs, launch arguments; the `intentic-files` process itself, its generations and trash asks, is `sidecar.rs`.
- [src-tauri/src/setup_link.rs](src-tauri/src/setup_link.rs) — every `intentic://` link and which senders it is believed from.
- [src-tauri/src/drop_copy.rs](src-tauri/src/drop_copy.rs) — a big drop on the workspace, copied into a sandbox on this computer through helper containers (Windows).
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs) — the Tauri commands This device calls, and the script each run starts.
- [src-tauri/src/resume.rs](src-tauri/src/resume.rs) and [src-tauri/src/prefetch.rs](src-tauri/src/prefetch.rs) — a Windows setup across restarts: the sign-in entry that resumes it, and the sandbox image fetched while Docker is installed.
- [src-tauri/src/wake.rs](src-tauri/src/wake.rs), [src-tauri/src/microphone.rs](src-tauri/src/microphone.rs) and [src-tauri/src/autostart.rs](src-tauri/src/autostart.rs) — the wake word with the window in the tray: what the page says and is told, the tray's rows, the microphone for the workspace alone, and the start at sign-in.
- [src-tauri/src/found.rs](src-tauri/src/found.rs) — what this computer already uses: the subscriptions its AI tools are signed in to, by who they are for, and the folders their histories name.
- [src-tauri/src/agents.rs](src-tauri/src/agents.rs) — the machine agents of this computer's environments: this app's own, and each running WSL distro's.
- [src-tauri/src/project.rs](src-tauri/src/project.rs) — a folder and its sandbox: what its dialog draws, the folder put in line for this computer's sandbox, and the project verbs its window runs.
- [src-tauri/src/machine_sandbox.rs](src-tauri/src/machine_sandbox.rs) — this computer's own sandbox: the record every window hears, the thread that makes and watches it, and the folders it attaches.
- [explorer-menu](explorer-menu) — "Open with Intentic" in Windows 11's own context menu: the menu command and the identity package it needs.
- [src-tauri/cli](src-tauri/cli) — `intentic .` in a terminal on Windows: the launchers for cmd/PowerShell and for WSL/Git Bash that the installer puts on PATH.
- [src/host.ts](src/host.ts) — this app's half of the local shell: its places, the account and its sandboxes, and the This device view it adds to the rail.
- [src/device/useDevice.ts](src/device/useDevice.ts) — This device's store: the machine's sandboxes, agent and engine, and the setups, recreates and syncs the app runs here.
- [src-tauri/src/engine.rs](src-tauri/src/engine.rs) and [src/components/EngineCard.vue](src/components/EngineCard.vue) — which engine this PC's sandboxes run on (Docker Desktop or Intentic's own), and the move between them (`ic engine move`), step by step on the card.
- [src-tauri/src/engine_keeper.rs](src-tauri/src/engine_keeper.rs) — Intentic's engine started again when it stops while this app runs.
- [src-tauri/src/os.rs](src-tauri/src/os.rs) and [src/device/intenticOs/SystemCard.vue](src/device/intenticOs/SystemCard.vue) — Intentic OS: the system as `ic os` reports it, the changes This device makes to it, and kiosk mode.
- [src-tauri/src/os_settings.rs](src-tauri/src/os_settings.rs) and [src/device/intenticOs/ThisComputer.vue](src/device/intenticOs/ThisComputer.vue) — Intentic OS: this computer's network, sound, screens, keyboard and drives as `ic os` reports them, the changes the This computer cards make, and the thread that watches the drives.

## Building

Linux builds need the WebKitGTK development packages (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`), plus `xdg-utils` and `file` for the AppImage.
[build-desktop.sh](../../_tools/scripts/desktop/build-desktop.sh) installs the full list on Debian and builds the
release artifacts.

Every installer carries two programs beside the app, both `externalBin` in `tauri.conf.json` and staged per target
triple into `src-tauri/binaries/` (gitignored), which every cargo command against the crate needs, a check or a
bundle:

- `intentic-files`, the local windows' file server, compiled with bun by
  [stage-local-files.sh](../../_tools/scripts/desktop/stage-local-files.sh) (`pnpm stage:local`). The same script
  stages the ripgrep its search runs into `src-tauri/binaries/search/`, which `resources` carry and `sidecar.rs` names
  to it (`--search-tools`; `INTENTIC_SEARCH_TOOLS` overrides): rg 15.2.0, checked against GitHub's sha256 for each
  asset, and on Windows a static Linux rg beside `rg.exe`, which runs inside a WSL distro for a folder that lives there.
- `intentic-ic`, the `ic` CLI every script the app runs installs (as `ic`, in `~/.intentic/ic/bin`), staged by
  [stage-desktop-ic.sh](../../_tools/scripts/desktop/stage-desktop-ic.sh) (`pnpm stage:ic`). A release stages the
  binaries `build-ic.sh --version <v>` made for the GitHub Release (release.yml's `ic-build` job hands them to both
  desktop builds) and refuses any other version. Any other bundle reuses a fresh build in `_sandbox/ic/dist-bin` or
  runs `build-ic.sh` itself, and fails when it cannot. `test:rust`, `lint:rust` and `dev` stage a debug cargo build
  for this host, or a placeholder the script warns about when there is none, since `cargo clippy` and `cargo test`
  only need the file to exist.

### Which Linux runs it

The Linux artifacts are linked on `_tools/ci-base`'s Debian 13 (glibc 2.41), and the binary imports `GLIBC_2.39`
symbols, so every Linux artifact needs glibc 2.39 or newer: Ubuntu 24.04, Debian 13, Fedora 40, RHEL, AlmaLinux and
Rocky Linux 10, openSUSE Tumbleweed and Leap 16.0, and anything newer. Ubuntu 22.04, Debian 12, RHEL 9 and Leap 15
are too old. The AppImage vendors WebKitGTK and GTK but never glibc, so the same floor applies to it.

`tauri.conf.json` declares the floor where package managers read it: the deb depends on `libc6 (>= 2.39)` and the
rpm requires `libc.so.6(GLIBC_2.39)(64bit)`, the capability glibc provides and rpmbuild itself would generate. The
rpm entry is a capability name rather than `glibc >= 2.39` because the bundler writes every rpm depends entry as a
bare name, and a name with a version in it matches no package. The deb's entry is the one source:
[glibc-floor.mjs](../../_tools/scripts/desktop/glibc-floor.mjs), run by `verify-desktop-bundle.sh` on every build,
reads it, fails when the rpm's entry disagrees, when a built package's metadata lacks the floor, or when any ELF in the
deb, rpm or AppImage (vendored libraries included) imports a newer `GLIBC_` version, and names the file and symbol.
Moving the floor means both entries, the download page (`_site/site/src/pages/download.astro`) and the quickstart's
desktop section. To check a local build, run `bash _tools/scripts/desktop/verify-desktop-bundle.sh <dist-bin dir>`.

The local face runs in a plain browser too, on the dev server alone: open
`http://127.0.0.1:47147/files/local?daemon=…&token=…&id=…&name=…&path=…[&home=1]` against a running `intentic-files`
granted that token. With no app behind the page, its commands are answered by a stand-in (`local/devDesktop.ts`,
Tauri's own IPC mock), for a machine picked by `?machine=fresh|host|setup`: a first launch, one hosting two sandboxes,
or one mid-setup; and this PC's own setup by `?pc=` (`ready`, `needsSetup`, `settingUp`, `restart`, `cantRun` and the
rest the stand-in lists), so every phase of This device's card for it can be looked at in a browser.

## First launch on Windows (2026-10-09)

At launch the app runs a read-only `ic docker prepare --dry-run` and streams the result to every local window as
`desktop://onboarding` (`onboarding.rs`, `src/onboarding/pc.ts`). The reader sees it on This device, in a card of its
own ahead of this computer's sandbox (`src/device/pcSetup/PcSetupCard.vue`, its phase from the pure
`pcSetup/pcCard.ts`): only on Windows, for as long as the PC is not ready, or nobody is signed in, or the first task
failed to start. Under a heading that says what agents are and where they run, it walks three numbered steps
(`pcCard.ts` `pcSteps`, drawn by `PcStep.vue`): **Prepare this PC**, **Sign in**, **Give agents a first task**. Each
step's marker says whether it is done, running, the next press, waiting on the reader, stopped or not open yet; only
open steps carry their controls. The sign-in never waits for the setup, but it only becomes the main action once the
PC is ready or its setup is running. The first task stays closed until someone is signed in, unless a task was already
begun, saved or failed. A PC that cannot run agents, or a check that could not say, gets the same heading with no
steps. While the card leads a computer with no sandboxes, the page's own lead line stands back. Step one lists only the
rows still to do; the met ones are a count beside the machine. Rows are labelled in
the desktop app's i18n (`desktop.onboarding.rows.*`), falling back to `ic`'s own `title` for an id the catalog does not
name; a row is ours, the reader's or blocked by `ic`'s `action` (`onboarding.rs` `row_state`). While the card is up,
This device's no-sandbox card stands back and this computer's sandbox, held for the PC's setup with nothing of its own
to ask, says only that it waits for it; the rail's tile spins while the setup runs, marks it needing the reader while
it waits or failed, and shows a quiet mark while it is offered (`src/device/badge.ts`).

> 2026-10-12: this card replaced the local shell's **Agents** view (`/agents`, a rail tile of its own), whose
> signed-out checklist listed every requirement already met, several under raw ids, and whose first-task step said its
> own heading twice. The dev stand-in draws every phase with `?pc=` (below).
>
> 2026-10-13: the card became the three steps above. Before, it was three blocks of equal weight under "Set up agents on
> this PC" beside a green check: signed out on a ready PC, its biggest element was a first-task box that could do
> nothing yet, and the one action that mattered, Sign in, was a small button between two rules.

A few seconds after the first launch, on an unmetered connection, the app prefetches what agents need: `ic engine fetch`
then `ic image prefetch`, parsing both with the same `intentic-prefetch:` markers (`prefetch.rs`). The reader can pause
it from This device's card; a metered connection waits until unmetered or the reader starts it anyway. The office editor download
(`sidecar.rs` `prefetch-office`) waits until that prefetch is `done` or `failed`.

"Set up this PC", the `/device` setup flow, and a folder's "Work on this with an agent" when Docker is not ready all
run the same consenting setup: `ic docker prepare --yes` with `INSTALL_DOCKER=1` (`onboarding_set_up`). When the PC is
ready and someone is signed in, `machine_sandbox.rs` makes this computer's sandbox as before; until then the machine
card waits on the PC setup and offers a hosted machine when this PC cannot run a sandbox.

Restarts use `/r /t 0` only — never a timed `/t` above zero, because Windows then implies `/f` and force-closes unsaved
work elsewhere (`commands.rs` `end_session`). Both a restart and a sign-out wait are parked in `~/.intentic/onboarding-pc-parked.json` as soon as setup
asks for them, with a sign-in entry that resumes setup automatically. “Sign out now” ends the Windows session;
its card asks the reader to save other work first. The entry stays through launches before the session ends:
the sign-in launch (`--resume-setup`) marks the park `resumed`, and only then does the entry go
(`onboarding.rs` `waits_for_session_end`).

Product events from the first launch (`onboarding_launched`, `onboarding_check`, `onboarding_prefetch`,
`onboarding_setup`, `onboarding_cloud`) are sent from `src/onboarding/pc.ts` through `analytics.ts`, keyed to the
install id; reasons are scrubbed with `installTelemetry.ts` `scrubReason`.

```sh
pnpm --filter @intentic/desktop-app tauri:dev        # the close question's page on :47146, workspace from INTENTIC_APP_URL
pnpm --filter @intentic/desktop-app dev:local        # the local face on :47147, proxied under :47146's /files
pnpm --filter @intentic/desktop-app check:rust       # rustfmt, clippy, cargo test
pnpm --filter @intentic/desktop-app stage:downloads  # local installers into _site/site/public/desktop/
```

## Intentic's engine (2026-10-09)

On a PC whose sandboxes run on Intentic's engine (`~/.intentic/engine/engine.json`, `active`), every `docker` this app
spawns goes to it (`scripts.rs` `docker`), the engine counts as listening when its TLS port takes a connection rather
than when Docker Desktop's pipe exists, and the Docker card's Start runs `ic engine start` instead of launching Docker
Desktop. A record that is installed but not switched on (a Docker Desktop PC holding the engine ready for a move)
changes nothing.

The engine keeper (`engine_keeper.rs`) looks every 20 seconds and, after two misses in a row, runs
`ic engine start --quiet`, waiting longer after each failed start (1, 2, 5, then 15 minutes). It leaves alone an engine
stopped on purpose (`held`), one the PC does not run on, and everything while a move or a setup runs; each start it
makes is reported as `desktop_engine_restarted`. Every desktop event carries `desktop_engine`.

The engine card on This device says which engine the sandboxes run on and moves them (`ic engine move`, confirmed
first): onto Intentic's engine from Docker Desktop, or back. While the migration's switch is off (`ic`'s
`engine/choice.rs`) the move is only kept in reach; once it flips, the card offers it, and "Not now" saves a preference
for Docker Desktop (`ic engine prefer`). A sandbox handed the GPU keeps the PC on Docker Desktop.

## Repair

Repair is an agent that runs in this app on the reader's PC, outside every sandbox. It can run read-only checks (`ic sandbox doctor`, `ic engine status`, `ic docker prepare --dry-run`, sandbox list/logs, setup transcript) and, after the reader taps **Allow**, mutating fixes (`ic sandbox fix`, `ic engine start`, `ic engine move` between Docker Desktop and Intentic's engine, sandbox restart/rollback). It has no shell and cannot edit project files. A move it starts runs through the engine card's own run (`engine.rs` `run_move`), so the card shows its steps.

Open it from the tray (**Repair Intentic…**), the workspace recovery panel (**Repair**), or `intentic://repair?slug=…&from=…&reason=…`. The web route is `/repair` in the local shell; Rust lives in `src-tauri/src/repair/`, TypeScript in `src/repair.ts`.

## Product analytics

`POSTHOG_KEY` enables reporting in a release build. `POSTHOG_HOST` selects the capture origin for both the webview and Rust launch reporter; it defaults to `https://us.i.posthog.com` and can be set to `https://eu.i.posthog.com`. The app records events only after the editor's Data & privacy consent is allowed.

## Process lifecycle telemetry and session-end smoke test

Rust queues `desktop_launched` for every process start, including launches into Workspace or only the tray.
It records the opened face, a new `launch_id` and the previous run's `previous_exit_reason`.
Every webview gets the same string as `window.__INTENTIC_LAUNCH_ID__`. Crash reports retain the panic's own
RFC3339 event timestamp, `at_exit` and `exit_cause` (`quit`, `restart`, `update`, `session-end`, `unknown`).
Older launch markers and queued reports remain readable. Consent still applies to this queue.

The Windows smoke workflow installs the candidate, runs `scripts/endsession-smoke.ps1`, and uninstalls it
before the existing installer tier. On a disposable Windows desktop with the app installed and closed:

```powershell
pwsh -File _editor/desktop-app/scripts/endsession-smoke.ps1 -Executable 'C:\path\intentic-desktop.exe'
```

It finds only the launched process's “Tao Thread Event Target”, sends `WM_ENDSESSION(1, ENDSESSION_CLOSEAPP)`,
and requires exit code 0, an exited session-end marker, and no `crash.json`. It does not sign Windows out.
The tao 0.37.1 handler calls `loop_destroyed()` then immediately `process::exit(0)`
([upstream fix #1157](https://github.com/tauri-apps/tao/pull/1157)), after Tauri's Exit cleanup, so this app
needs no extra process-exit guard. The direct Windows/WebView2 pins match wry's versions; zbus 6 removes
the blocking API, so notifications and dock updates now use its async API on Tauri's runtime.

`rust-ini` is constrained to 0.21.1: deep-link 2.6.2 constructs a two-field `ParseOption`, while
0.21.2/0.21.3 added required public fields. The latest plugin otherwise fails to compile on Linux.
Remove this compatibility constraint once upstream defaults the newly added fields.
