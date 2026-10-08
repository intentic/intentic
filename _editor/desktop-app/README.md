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
- **The main window.** The editor's shell with the sandbox shell's rail, holding what needs no sandbox and no
  account: at the top the place chip (the folder this window shows, and the account's sandboxes, each opening the
  workspace on itself at `/?sandbox=<id>` and picked from anywhere in the window by Alt+1–9 as in the workspace, or
  the sign-in before an account), then Files (the folder's tree and documents, `/workspace`), then This device
  (`/device`), and at the foot the sandbox shell's own account control (who is signed in, Settings, Sign out), or the
  sign-in in the default browser until there is an account. Settings open in the window itself (`#/settings`), and
  signing out leaves it on its folder. The sandboxes and the account are what the workspace last told the app: its
  switcher hands them over on `intentic://roster` whenever either changes, a sign-out empties them, and the app keeps
  them in `roster.json` (`local_roster`), with no address, token or logo, so a row carries a name, where it runs and
  whether it is shared, and no count or state, and the account an address, a name and an `https` avatar. Before the
  workspace has said, the row is the workspace itself; the account menu shows the named account at once and then
  what the platform answers (below). It opens on the folder it was last
  pointed at (`home-folder.json`), or on `~/intentic/local`, which a first launch creates: nothing is asked before the
  first screen. A folder picked in the system's dialog from an empty folder's page, or one of the folders that page
  offers (below), takes the window's place
  (`local_pick`, then `point`: a grant of its own, the old one revoked, the page reloaded onto the new face at
  `#/workspace`); a folder another window already shows raises that window instead. Other folders and documents open
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
  loading, is loaded at the address, as before the opener existed.
- **Native work is the public scripts.** Setup, sync and everything done to a sandbox run the same `connect`,
  `sync` and `recreate` scripts the copy-paste one-liners run. `stage-desktop-scripts.sh` copies them from
  `_site/site/public/scripts` at the current commit, so an uncommitted script edit does not reach `tauri dev` or a
  local installer. Each run is told this build's own release (`IC_URL`, `IC_VERSION`), and a shim fetches `ic` only
  when the installed one is older than that: the pin is a floor, compared as a version (major.minor.patch, a pre-release
  below its release), never a ceiling.

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
- **Tray-resident.** The × of either face hides it into the tray, once the first × has asked whether that is what
  closing should do (`close-action.json`, "Keep Intentic in the tray" or "Quit Intentic"). The tray's "Open Intentic"
  opens the last face, "This computer" the main window, "Open workspace" appears once an account has been seen, then
  "Open a folder…" and "Open a file…" (each in a window of its own), the machine agent's row (This device), the update
  row and Quit. Updates download in the background and install on quit or from the editor's banner or This device;
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
- **Sign-in runs in the default browser**, because Google refuses OAuth inside an embedded webview. The credential
  returns over `intentic://auth`, which also records that this install has an account (`account-seen.json`) and opens
  the workspace at `/desktop-auth/complete`, in the main window's place.
- **The last face.** `last-face.json` (`home` or `workspace`) is the face the user was last seen choosing: every
  showing of the workspace writes `workspace`, and the main window shown on purpose (a launch into it, the tray's "This
  computer", the workspace's way back) writes `home`. An install without the file reads `workspace` if it ever showed the
  workspace (`workspace-seen.json`) and `home` otherwise. A launch opens This device for a setup parked across a Windows
  restart, then for a machine that hosts a sandbox and has no Docker engine listening (handing over to the workspace
  once the engine wakes, when the workspace is the last face), and otherwise the last face (`opening` in
  `src-tauri/src/lib.rs`). A bare second launch opens the last face too. `home_facts` hands the shell `accountSeen` (a
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
  once, whatever the sandbox is doing; nobody signed in is sent to sign in by the same press.

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
  `ready`, `stopped`, `failed` (with its log), `interrupted`, and `gone` (the account no longer lists it and it is not on
  this computer). It looks again at launch, at every roster the workspace sends, at a sign-in or a sign-out, at a press,
  every 15 seconds while Docker is awaited, every minute while it is not ready and every five once it is. A quit stops a
  setup under way with everything it started; the next launch finds the record `creating`, says it was interrupted, and
  runs it again on the same row with its code minted afresh (the platform hands back the live one). The system's
  notification says once that it is ready and once each time it newly needs the reader, and nothing while a window of
  this computer has the focus, where the card says it already.

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

  Once it is ready, each folder in line is attached by the machine agent (`intentic-machine sync attach --sandbox-url
  https://<hostname> --dir <folder> --name <name> --json`, which only records the pairing), remembered in
  `projects.json` with this computer's sandbox, and every window on it hears so (`intentic:sandbox`). The app then
  follows the folder's first copy in `intentic-machine status --json` until the agent's word for its Mutagen session is
  `watching`. Every local window carries a card in its corner while this computer's sandbox is not ready, in the
  notification lane (the web's `local/LocalMachineCard.vue`, worded by `local/machineCard.ts`): the house goes up stage
  by stage as the setup's real phases arrive (the plans, the ground and its materials as the image arrives, the walls as
  the container starts, the roof as the daemon comes up, the lights as it answers), then the folder's copy moves in
  through the door. It says every state with the one press that moves it on (Sign in, Start Docker, This computer for
  the requirements, Try again beside the log, Start, Make a new one), folds to a line, and remembers the fold for what it
  showed in every window. The folder's button says how far it is ("Waiting for this computer's sandbox (42%)", "Copying
  your folder…") and then opens the sandbox on the folder (`/?sandbox=<id>&project=<name>`, the web's
  `router/sandboxArrival.ts`), never on the `/work` around it. This device leads with the same states and presses
  (`src/device/MachineSandboxSection.vue`), and the rail's tile spins while it is made and marks it while it needs the
  reader.

  The folder is copied into the sandbox's `/work/<name>` and kept up to date from here; agents change the copy, and
  nothing in the folder changes until the window's "Bring back changes", which keeps a restore point first. A folder
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
- **Uninstalling on Windows** (`src-tauri/installer-hooks.nsh`, 2026-10-05). The uninstaller ends the app and its
  file server (`intentic-files.exe`, which an install over the app ends too: a slow exit held its file), then asks "Also
  remove the Intentic machine agent from this PC?" where one is installed. Yes runs `intentic-machine uninstall`, which
  removes this PC's links, sync pairings and login entry, the keeper that starts Docker Desktop at every sign-in with
  them, and never a container. Never asked on an update or a passive uninstall; a silent one answers no. It signs out on
  this PC: the webview's cookie files (`%LOCALAPPDATA%\dev.intentic.desktop\EBWebView`) and `roster.json` go, whether or
  not "Delete app data" is ticked; the platform's own record of the session is left to expire, since the uninstaller has
  no way to send it. Its last page says what stays: the sandboxes and their files, in Docker, which `ic sandbox list`
  shows and `ic sandbox remove <name>` removes (recoverable for a week), and the agent where it was kept. `ic` and its
  PATH entry stay, since they are how the sandboxes are removed. Before, the uninstaller removed the app alone, and said
  nothing.
- **"Open with Intentic" in Windows 11's own menu** ([explorer-menu](explorer-menu), 2026-10-07). The installer used to
  register it as classic registry verbs only, which Windows 11 shows under "Show more options" and never in its new
  menu: that menu lists only commands declared by an app package. `intentic_explorer_menu.dll`, installed beside the
  app, is such a command, on folders, the space inside one and the document types the app opens, and the installer
  hooks register the identity package that declares it (`regsvr32 /n /i:<mode>`). A release that holds the code-signing
  certificate ships that package signed and it registers silently; otherwise the first interactive install signs one
  on the PC behind one UAC prompt. Updates and passive installs never prompt. Wherever the package is not in place
  (Windows 10, a declined prompt, a failure), the classic verb is written instead, so the entry is in one menu or the
  other and never both.
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
| `auth?handoff=…&state=…[&profile=…]` | anywhere | Completes a sign-in this app started and opens the workspace at `/desktop-auth/complete`. |
| `sync?url=…&pair=…[&name=…][&takeover=1][&mirror=1]` | app windows | Enrolls this device in desktop sync from This device; the folder is picked in a system dialog. |
| `sync?url=…&pair=…&project=<name>[&sandbox=<id>]` | app windows | A hosted sandbox's project: syncs the parked folder with `/work/<name>` and remembers it with that sandbox. |
| `recreate?slug=…[&hash=…][&rollback=1]` | app windows | Moves the sandbox to the `:stable` base, a pinned overlay, or its previous image, from This device. |
| `fix?slug=…[&code=…]` | app windows | Runs `ic sandbox fix` for that sandbox here and shows it on This device; `code` is the recovery panel's fix code, which `ic` claims so the panel follows the run. A slug or code that is not a plain token drops the link. |
| `update` | app windows | Installs the downloaded update and restarts. |
| `launcher[?to=files]` | app windows | Brings the main window back in the workspace's place: at This device (a setup's way back to its run, a sandbox's restart), or at its folder with `to=files` (the sandbox switcher's "This computer"). |
| `badge?mark=…[&count=…][&tooltip=…][&icon=…][&overlay=…]` | app windows | The workspace tab's mark (`none`, `asks`, `done`, `working`, `offline`) on the app's icon: `icon` for the tray and `overlay` for the Windows taskbar button, each a PNG as unpadded URL-safe base64 of at most 64 KiB and 256 pixels a side; `count` for a Linux dock, heard only with `asks`; `tooltip` after the app's name in the tray's, one line of at most 100 characters. A value out of shape drops the link. |
| `notice?do=show&key=…&kind=asks\|finished&title=…[&body=…][&path=…][&silent=1]` | app windows | Puts up one of the system's notifications, replacing the one under the same `key`. `path` is a workspace route (`/?sandbox=<id>&conversation=<id>`) a press opens, `silent` asks for no sound. `do=withdraw&key=…` takes one down, `do=clear` all of them, and `do=status` asks whether the system shows them at all (answered as `intentic-desktop-notices`). A line that is empty, too long or holds a control character, or a path that is not rooted or starts `//`, drops the link. |
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
| `intentic-desktop-setup` | workspace | This device's setup progress (`SetupReport`). |
| `intentic:face` | a worn spare | none: `window.__INTENTIC_LOCAL__` has just been set. |
| `intentic:open` | local folder window | `{ path }` of a document inside its folder, root-relative. |
| `intentic:close-requested` | local window | none: a close is held for unsaved changes. |
| `intentic:project` | local folder window | `{ kind: "changes" \| "brought-back" \| "restored" \| "direction", result }`, `result` being the machine agent's own `{ ok, … }`; or `{ kind: "error", verb, error }` when the agent is missing, would not start, timed out or printed no JSON, or the folder has a run under way already. |
| `intentic:navigate` | main window | `{ path }`, a route of the local shell (`/device`): the screen the app raised the window for. |
| `intentic:sandbox` | local folder windows | `{ sandbox: true }`: the window's folder has its own sandbox now (`project.rs` `remember`), kept in its face for its reloads. |
| `intentic:project-ask` | local folder window | none: put up the folder's sandbox dialog (`sandbox` asked by link for a folder with none). |

A local window also hears the app's Tauri events, which This device listens on: `desktop://run` (a script run's
`started`, `line` and `exit`), `desktop://pending-setup`, `desktop://pending-recreate`, `desktop://pending-sync`,
`desktop://update`, and `desktop://machine-sandbox` (this computer's own sandbox, its whole record on every change).

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
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs) — the Tauri commands This device calls, and the script each run starts.
- [src-tauri/src/found.rs](src-tauri/src/found.rs) — what this computer already uses: the subscriptions its AI tools are signed in to, by who they are for, and the folders their histories name.
- [src-tauri/src/agents.rs](src-tauri/src/agents.rs) — the machine agents of this computer's environments: this app's own, and each running WSL distro's.
- [src-tauri/src/project.rs](src-tauri/src/project.rs) — a folder and its sandbox: what its dialog draws, the folder put in line for this computer's sandbox, and the project verbs its window runs.
- [src-tauri/src/machine_sandbox.rs](src-tauri/src/machine_sandbox.rs) — this computer's own sandbox: the record every window hears, the thread that makes and watches it, and the folders it attaches.
- [explorer-menu](explorer-menu) — "Open with Intentic" in Windows 11's own context menu: the menu command and the identity package it needs.
- [src/host.ts](src/host.ts) — this app's half of the local shell: its places, the account and its sandboxes, and the This device view it adds to the rail.
- [src/device/useDevice.ts](src/device/useDevice.ts) — This device's store: the machine's sandboxes, agent and engine, and the setups, recreates and syncs the app runs here.

## Building

Linux builds need the WebKitGTK development packages (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`), plus `xdg-utils` and `file` for the AppImage.
[build-desktop.sh](../../_tools/scripts/desktop/build-desktop.sh) installs the full list on Debian and builds the
release artifacts.

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
or one mid-setup.

```sh
pnpm --filter @intentic/desktop-app tauri:dev        # the close question's page on :47146, workspace from INTENTIC_APP_URL
pnpm --filter @intentic/desktop-app dev:local        # the local face on :47147, proxied under :47146's /files
pnpm --filter @intentic/desktop-app check:rust       # rustfmt, clippy, cargo test
pnpm --filter @intentic/desktop-app stage:downloads  # local installers into _site/site/public/desktop/
```
