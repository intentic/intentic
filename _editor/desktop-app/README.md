# desktop-app

The Tauri app for Windows and Linux that sets up and runs an intentic sandbox on the user's own computer, opens the hosted workspace in its window, and opens the user's own folders and documents in windows of their own.

```mermaid
flowchart LR
    spa["Workspace face<br/>hosted editor, no IPC"] -->|"intentic:// navigation"| app(["desktop-app<br/>Rust shell"])
    os["OS link handler<br/>browser, second launch"] -->|"intentic://"| app
    launcher["Launcher face<br/>src/ Vue bundle"] -->|"Tauri commands"| app
    local["Local windows<br/>the editor on a folder"] -->|"intentic://window, local"| app
    app -->|"stdin: grants, answers"| files["intentic-files<br/>sidecar"]
    files -->|"stdout: asks"| app
    local -->|"HTTP on loopback, token"| files
    app -->|"spawns"| scripts["Staged scripts<br/>connect, sync, recreate"]
    app -->|"sync changes, bring-back"| machine(["intentic-machine"])
    app -->|"list --json, sandbox fix"| ic(["ic"])
    scripts --> ic
    ic --> docker["Docker<br/>sandbox + tunnel"]
    app -->|"sign-in"| browser["Default browser"]
    app -->|"updater"| release["GitHub release<br/>latest.json"]
```

- **One window, two faces.** The workspace face loads the hosted [web](../web) editor from `https://app.intentic.dev`
  (or the `appUrl` setting, or `INTENTIC_APP_URL`) as remote content with no IPC. The launcher face is this
  package's `src/` bundle: local, and the only window granted Tauri commands (`src-tauri/capabilities/launcher.json`).
  A panel the editor floats out gets a frameless window of its own.
- **Home.** The launcher's own screen (window title "Intentic"; `src/home.ts` decides what it shows). It leads with
  "Open anything on this computer": Open folder…, Open file… and a drop zone, which needs the launcher's native drop
  handler left on. Below it, up to 12 recents (a filter past 6) with their age, a Sandbox chip for a folder with a
  sandbox of its own, a remove (`local_forget_recent`), a moved or deleted path dimmed as such, and a failed
  `local_open_path` said under its row. The agents row offers Sign in (`sign_in`) until an account has been seen, then
  Open workspace (`workspace_open`). The "This device" block (Docker, the machine agent, sync, sandboxes, "See all
  your devices") shows only on a machine that needs it (`deviceShown`), so a files-only machine sees no Docker; the
  app's URL is the version's tooltip. The header's × and Esc call `launcher_close`, labelled "Close" or "Back to your
  workspace" by `lastFace` (Esc clears a typed filter first). The launcher is hidden, never destroyed, so it re-reads
  `home_facts` and `local_recents` whenever it is focused or shown.
- **Native work is the public scripts.** Setup, sync and everything done to a sandbox run the same `connect`,
  `sync` and `recreate` scripts the copy-paste one-liners run. `stage-desktop-scripts.sh` copies them from
  `_site/site/public/scripts` at the current commit, so an uncommitted script edit does not reach `tauri dev` or a
  local installer.
- **What runs is `ic`'s to say.** The manager's list is `ic sandbox list --json` from the installed `ic` (the shim's
  `--list` when that one is missing or older than this app, whose fetch brings it level). Start, stop and restart are
  `recreate --start|--stop|--restart`, and the Resources form's Apply and Save are `recreate --shape`, all `ic` verbs
  behind the shim's switch, so a Restart here applies a shape saved for the next restart exactly as a Restart from
  the web does. Remove is `recreate --remove`, `ic sandbox remove -y`: the sandbox goes into `ic`'s trash, and its
  `/work` and `/history` stay recoverable for a week (`ic sandbox restore`), as they do from every other door. The
  confirmation says so, in place of the kit's "cannot be undone". The app reads nothing off `docker inspect`; the
  short children it waits on (Docker probes, the listing, the agent's status) share `ic`'s time-limited capture
  crate, `_sandbox/ic/bounded`.
- **Fixing a sandbox the workspace cannot reach.** The workspace's recovery panel sends `intentic://fix?slug=…`, and
  the launcher runs `ic sandbox fix <slug> [--code <code>] --source app --json` with the installed `ic`, looked for
  where the manager's listing looks, with no console window, one run at a time, and stopped with everything it started
  after ten minutes (`src-tauri/src/fix.rs`). A second link while one runs brings that run forward. The card at the
  top of Home is built from `ic`'s `intentic-fix:` progress lines and its final report (`src/fixReport.ts`): what `ic`
  is doing now, every check with its state and, for one that warns or fails, the problem and the remedy, then the
  outcome and what the exit code leaves (3: a yes nobody could give in a terminal; 4: a restart or sign-out). Each
  check whose fix waits on consent becomes a button that runs the fix again with `--accept <that check>` and no code.
  An `ic` that ends without a report, one from before `sandbox fix`, is said to be unable to fix yet, with setting
  the sandbox up again as the way to update it, and nothing retries. `ic` posts every run to the platform itself; the
  app never talks to the platform about it.
- **Tray-resident.** The × hides the workspace, and the launcher's ×, Esc and platform close go back to the
  workspace when that is the face in use and it is still open, or else hide the card into the tray
  (`launcher_close`). The tray's "Open Intentic" opens the last face, "Home" opens Home, "Open workspace" appears
  once an account has been seen, then "Open a folder…", "Open a file…", the machine agent's row, the update row and
  Quit. Updates download in the background and install on quit or from the editor's banner; deb and rpm installs
  cannot replace themselves and link to the download page instead. A local window never draws the update banner.
- **Sign-in runs in the default browser**, because Google refuses OAuth inside an embedded webview. The credential
  returns over `intentic://auth`, which also records that this install has an account (`account-seen.json`).
- **The last face.** `last-face.json` (`home` or `workspace`) is the face the user was last seen choosing: every
  showing of the workspace writes `workspace`, and Home shown on purpose (a launch into it, the tray's "Home", "Open
  Intentic" on an install last used through Home) writes `home`. An install without the file reads `workspace` if
  it ever showed the workspace (`workspace-seen.json`) and `home` otherwise. A launch opens the launcher for a setup
  parked across a Windows restart, then for a machine that hosts a sandbox and has no Docker engine listening, then
  Home when the last face is Home on a machine that hosts no sandbox, and the workspace otherwise (`opening` in
  `src-tauri/src/lib.rs`). A bare second launch opens the last face too. `home_facts` hands Home `accountSeen` (a
  sign-in, or the workspace ever shown), `lastFace` and `hostsSandboxes`.
- **Local windows.** A folder or a document opened from Home, the tray, a double-click ("Open with Intentic" on
  documents, folders, the space inside one and a drive root), a drop on Home or a second launch gets a window of its
  own (`files-<n>`, `src-tauri/src/local.rs`). A document inside the folder of a window already open is handed to that
  window instead (`intentic:open`), and a path already being opened is not opened twice. The window shows the local
  face: the editor itself, built from `_editor/web` into `dist/files/` (`vite.local.config.ts`, entered through
  `local/main.ts`), with its file reads answered by the `intentic-files` sidecar
  ([local-files](../../_devices/local-files)) instead of a sandbox. The app starts the sidecar (a few seconds after a
  launch into Home, or one with recents), grants each window one folder by a random token on the sidecar's stdin, and
  revokes it when the window closes (`src-tauri/src/sidecar.rs`). A local window holds no capability: every app
  command is a permission granted by name (`build.rs`), and its only links are its own title bar and `local`. No
  sandbox, account or Docker is involved. What fails to open is said in a native dialog in the user's words (Home
  shows the same sentence under the row), and the original error goes to stderr.
- **The warm window.** After the first local window of a run, the app keeps one hidden spare files window whose page
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
- **A folder's own sandbox, copy-first.** "Work on this with an agent" in a folder's window
  (`src-tauri/src/project.rs`) refuses a disk, a home folder (a Fedora Atomic home under `/var/home` included), a
  system folder and one inside or around a folder that already has a sandbox, says what copy-first means, then parks
  the folder and opens the workspace's `/setup?project=<name>`. The folder is copied into the sandbox's
  `/work/<name>` and kept up to date from here; agents change the copy, and nothing in the folder changes until the
  window's "Bring back changes", which keeps a restore point first. The setup page answers with
  `intentic://setup?…&project=<name>` for a sandbox on this machine, run with `SYNC_DIR`, `SYNC_REMOTE_DIR=/work/<name>`
  and `SYNC_PROJECT=1`, or with `intentic://sync?…&project=<name>&sandbox=<id>` for a hosted one, whose sync script
  runs here on the parked folder with the same three values (a folder is asked for in a system dialog when none is
  parked). Either way the folder is bound to the one this app parked (never to a path on a link), and
  `projects.json` remembers it so opening the folder again reaches the same sandbox. The window's project verbs
  (`changes`, `bring-back`, `restore`, `direction`) each run the machine agent, `intentic-machine sync <verb> --dir
  <folder> … --json`, and hand its JSON object back to the window as `intentic:project`. The paths a bring-back is
  limited to go in a JSON file (`--paths-file`, in the app's cache, removed after the run), never on the command
  line, which Windows caps at 32,767 characters. One bring-back, restore or direction change runs per folder at a
  time, and an update waits for it.
- **"Ask about this".** A local window can hand one of its files to the workspace: the app grants it to the sidecar
  read-only, for the workspace's origin alone and for fifteen minutes (a handoff grant, never a window), and opens
  the workspace at `/?handoff=<base64url of { url, token, name }>`, where `url` is the sidecar's
  `/workspace/raw?path=<name>`.
- **Deletes go to the Recycle Bin.** A delete in a local window reaches the sidecar, which asks the app (`ask`,
  `verb: trash`); the app moves the entry to the OS's Recycle Bin or Trash (the `trash` crate) when it lies strictly
  inside the folder of an open folder window, and answers.

## The link surface

`intentic://` is the only channel from a page into the app. Navigations in the app's own windows are intercepted
in `windows.rs`. Links from anywhere else arrive through the OS scheme handler, which on Linux is the desktop entry
built from [src-tauri/main.desktop](src-tauri/main.desktop). [setup_link.rs](src-tauri/src/setup_link.rs) parses
every link and drops what an outside sender may not ask for. The editor builds them in
`_editor/web/src/app/environments/desktop.ts`.

| Link | Accepted from | Does |
| --- | --- | --- |
| `setup?code=…[&sandbox=…][&name=…][&syncDir=…]` | anywhere; outside asks first | The launcher runs that sandbox's setup here. `cfToken`, `platform` and `project` count only from the app. |
| `signin[?switch=1]` | anywhere | Opens platform sign-in in the default browser; `switch` asks for the account chooser. |
| `auth?handoff=…&state=…[&profile=…]` | anywhere | Completes a sign-in this app started and opens the workspace at `/desktop-auth/complete`. |
| `sync?url=…&pair=…[&name=…][&takeover=1][&mirror=1]` | app windows | Enrolls this device in desktop sync; the folder is picked in a system dialog. |
| `sync?url=…&pair=…&project=<name>[&sandbox=<id>]` | app windows | A hosted sandbox's project: syncs the parked folder with `/work/<name>` and remembers it with that sandbox. |
| `recreate?slug=…[&hash=…][&rollback=1]` | app windows | Moves the sandbox to the `:stable` base, a pinned overlay, or its previous image. |
| `fix?slug=…[&code=…]` | app windows | Runs `ic sandbox fix` for that sandbox here and shows it in the launcher; `code` is the recovery panel's fix code, which `ic` claims so the panel follows the run. A slug or code that is not a plain token drops the link. |
| `update` | app windows | Installs the downloaded update and restarts. |
| `launcher` | app windows | Brings the launcher face back. |
| `window?do=…` | app and local windows | The editor's own title bar: `ready`, `minimize`, `maximize`, `close[&confirmed=1]`, `dirty&value=0\|1`, `drag`, `raise`, `fit`, `mode`. |
| `local?do=…` | local windows only | `open-folder` and `open-file` in the system dialog, `reveal[&path=…]` an entry of the window's own folder, `sandbox`, `ask&path=…`, and the project's `changes`, `bring-back[&paths=<JSON array>]`, `restore&point=…`, `direction&value=to-sandbox\|both`. |

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
| `intentic-desktop-update` | workspace | `{ version }` of a downloaded update. |
| `intentic-desktop-setup` | workspace | The launcher's setup progress (`SetupReport`). |
| `intentic:face` | a worn spare | none: `window.__INTENTIC_LOCAL__` has just been set. |
| `intentic:open` | local folder window | `{ path }` of a document inside its folder, root-relative. |
| `intentic:close-requested` | local window | none: a close is held for unsaved changes. |
| `intentic:project` | local folder window | `{ kind: "changes" \| "brought-back" \| "restored" \| "direction", result }`, `result` being the machine agent's own `{ ok, … }`; or `{ kind: "error", verb, error }` when the agent is missing, would not start, timed out or printed no JSON, or the folder has a run under way already. |

## The sidecar's control lines

The app writes JSON lines on `intentic-files`' stdin and reads its stdout (`_devices/local-files/src/control.ts`).
Each spawn is a generation: a start that does not hear `ready` within 20 seconds kills its child, only the current
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
| `{"op":"prefetch-office"}` | in | Fetch the office editor now: once per run, after Home at launch or the first local window, never with `INTENTIC_DISABLE_UPDATE_CHECK` set. |
| `{"event":"ready","port"}`, `granted`, `refused`, `revoked` | out | Where it listens, and what it made of each grant. |
| `{"event":"ask","id","verb":"trash","path"}` | out | Move this entry to the Recycle Bin or Trash. |
| `{"event":"office","state":"ready"\|"failed"[,"error"]}` | out | Where the office editor's download went; logged. |

## Key files

- [src-tauri/src/lib.rs](src-tauri/src/lib.rs) — startup: plugins, the command list, the tray and what a launch opens onto.
- [src-tauri/src/setup_link.rs](src-tauri/src/setup_link.rs) — every `intentic://` link and which senders it is believed from.
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs) — the Tauri commands the launcher calls, and the script each run starts.
- [src-tauri/src/local.rs](src-tauri/src/local.rs) — the local windows: each window's grant, the warm window, handoffs, launch arguments; the `intentic-files` process itself, its generations and trash asks, is `sidecar.rs`.
- [src/App.vue](src/App.vue) — Home: this computer's files, recents and an agent, plus Docker, sandboxes and sync for a machine that hosts them; a handed-over setup.
- [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) — bundle targets, updater endpoint, the deep-link scheme and the Linux glibc floor.

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

```sh
pnpm --filter @intentic/desktop-app tauri:dev        # launcher on :47146, workspace from INTENTIC_APP_URL
pnpm --filter @intentic/desktop-app dev:local        # the local face on :47147, proxied under the launcher's /files
pnpm --filter @intentic/desktop-app check:rust       # rustfmt, clippy, cargo test
pnpm --filter @intentic/desktop-app stage:downloads  # local installers into _site/site/public/desktop/
```
