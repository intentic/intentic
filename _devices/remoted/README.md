# remoted

`intentic-remoted`, the daemon on one of the owner's computers that serves people's terminals (and, from phase 2, its screens) to the editor over an uplink it dials to each sandbox that turned remote access on.

```mermaid
flowchart LR
    agent["intentic-machine<br/>device/remote/"] -->|"spawns, writes remoted.json"| remoted(["intentic-remoted"])
    remoted -->|"status lines on stdout"| agent
    remoted -->|"wss …/system/device-uplink<br/>one yamux session per sandbox"| netd["Sandbox's netd"]
    netd -->|"a stream per viewer or daemon call<br/>HTTP/1.1 on each"| remoted
    editor["Editor terminal"] -->|"/system/device-terminal/&lt;device&gt;/&lt;session&gt;"| netd
    remoted --> pty["ConPTY / openpty<br/>pwsh, cmd, wsl.exe -d, login shell"]
```

One process per computer environment, beside that environment's machine agent: the Windows side of a PC, a Linux
machine, and each WSL distro that runs an agent of its own, whose remoted is a Linux one serving native Linux shells
there. The machine agent starts it only while some link's remote switch is on, and it serves one uplink per linked
sandbox, each with that sandbox's own token, key and switches, and its own terminals: one sandbox cannot list, open or
end another's.

(2026-11-20) Each connection is served by its own remoted, and the sandbox decides it
([`remote-environments.ts`](../../_sandbox/sandbox/src/hosts/remote/remote-environments.ts)): a terminal opened on a
distro's row is that distro's own remoted's `native` shell, and the screen is the Windows side's alone (a distro's
connection offers none). The Windows side's remoted still lists `wsl:<distro>` for every distro `wsl.exe` can enter;
the sandbox leaves out and refuses there every distro with a connection of its own, so `wsl.exe -d` serves only a distro
with no agent. Rejected: the Windows side's remoted as the only one on a PC, reaching each distro through `wsl.exe -d`;
a distro with its own agent would have had two remoteds offering its shell.

## Command line, configuration, status

`intentic-remoted run --config <file> [--parent-stdin] [--sandbox-url <url> --device <name>]`; `intentic-remoted version`
prints the bare version (`0.0.0` from source, the release's when `build-remoted.sh --version` stamped it through
`INTENTIC_REMOTED_VERSION`). On Windows, `intentic-remoted service status|install|uninstall` manages the lock screen
and admin prompts service and `desktop-helper` is that service's helper (below, "The lock screen and admin prompts").
On Linux, `intentic-remoted encoder-probe <nvenc|vaapi|vaapi-vpp>` is one hardware encoder's self-test, which remoted
runs in a child process of its own (below, "Encoders"), its answer one JSON line.

- **`--config`** is JSON the agent writes 0600 by rename, read again within 500 ms of a change
  ([`src/config.rs`](src/config.rs)), so a switch reaches remoted inside the 2 s the agent promises without a restart:
  `{ paused, notBefore, uplinks: [{ id, url, device, uplinkToken, mediaKey, allow: {view, control, terminal},
  generation, iceServers? }] }`. `url` is the sandbox's daemon base (loopback when it runs on this computer); `mediaKey`
  is base64url and tokens are checked under its decoded bytes. `iceServers` are the sandbox's `remoteIceServers` URLs
  (`stun:host:port`), written by an agent that advertises `remote-ice`; absent, screens offer host candidates only. A file that does not parse leaves the last good one standing, said
  once. With `--sandbox-url` and `--device` the file holds one uplink's fields at its top level instead (by hand, tests).
- **`--parent-stdin`**: remoted ends when stdin ends. The agent holds the pipe, so remoted never outlives it, on Windows
  included, where a killed parent takes no child with it. Its terminals end with it.
- **What changes do.** An uplink's terminal switch turned off ends that uplink's terminals (each viewer told why) and
  refuses new ones; its view switch turned off closes its screens' sockets, its control switch turned off leaves them
  watching; an uplink removed is closed and its terminals ended; `notBefore` moving drops every person's socket
  and refuses every token minted before it (`intentic-machine remote end`); `paused` (the person's pause hotkey) drops
  everyone's typing. What stays allowed keeps running.
- **Status**: one JSON line on stdout at start and on every change ([`src/status.rs`](src/status.rs)):
  `{type: "status", version, pid, uplinks: [{id, state, generation, since, error?}], people: [{uplink, kind, session,
  readOnly, since}], terminals, environments, monitors, paused}`. `state` is `connecting`, `up`, `down`, `withdrawn` or
  `refused`; `generation` is the config's for that state, so the agent waits for `up` at the generation it just wrote.
  The log goes to stderr (`RUST_LOG`, default `info`), in castd's format.

## The uplink

([`src/uplink.rs`](src/uplink.rs)) `GET <url>/system/device-uplink` upgraded to a WebSocket with `authorization: Bearer
<uplinkToken>` and `x-intentic-device: <device>`; its binary messages carry one yamux session, exactly the ingress
tunnel's carrier: the tunnel crate's `pump` (`Liveness::Listens`, since netd pings every 15 s; either end drops a peer
silent 45 s) and `mux::server`. netd opens a stream per viewer and per daemon call and remoted serves each as one
HTTP/1.1 connection ([`src/http.rs`](src/http.rs)); remoted opens none. TLS is rustls with ring, trusting the bundled
Mozilla roots and this computer's own store.

- A drop is dialled again after 1 s, doubling to 30 s with a fifth of jitter, from the start again after an uplink that
  held 30 s: a sandbox restarting is back within one or two tries. A newer uplink of the same device closing this one
  (4001) is a drop like any other.
- The sandbox withdrawing it (4003) stops the dialling until the agent starts it again, which moves its `generation`.
- 401 or 403 on the upgrade (a token or a device the sandbox does not know) is `refused`, tried again on a backoff up to
  5 minutes, and at once when the agent writes a new token.
- A changed `url`, token or device closes a held uplink (1000) and dials again; a changed switch does not.

## What is served on a stream

| Route | Answer |
|---|---|
| `GET /health` | `{ok, version}` |
| `GET /info` | `{version, monitors, environments, encoders, screen, allow, paused}`; `environments` is `native`, then `wsl:<distro>` for each distro on a Windows PC (Docker Desktop's own left out); `screen` says how this computer's screens are reached (below) |
| `POST /terminals` | `{session, environment?, shell?, cwd?, cols?, rows?}` → 201 `{session, title, environment, createdAt, viewers}`; 400 (a name not `[A-Za-z0-9_-]{1,64}`, an unknown environment or shell), 403 (terminal switch off), 409 (name taken), 429 (16 per uplink, 64 in all), 500 (the program did not start) |
| `GET /terminals` | the uplink's terminals, oldest first |
| `DELETE /terminals/<session>` | `{ok: true}`, or 404 |
| `POST /viewers/drop[?read_write=1]` | castd's drop for this uplink: closes its viewers with 4001 (only those that can type) and refuses tokens minted before now; `{dropped: n}` |
| `GET /stats` | `{uptimeS, terminals, viewers, screens: [{monitor, viewers, encoder, capture?}], uplinks}`; `encoder` is what the screen's current picture is encoded with (`nvenc`, `mf`, `openh264`, …); on Windows `capture` is `{via, blocked?, reason?, error?, since}`: duplication (`dxgi`), the service's helper (`helper`), `gdi`, or a `placeholder`, and why |
| `GET /screenshot/<session>` | a running screen's picture as its viewers get it (a placeholder included), PNG; 403 viewing switched off, 404 not running (a screenshot opens no screen) |
| `GET /terminal/<session>?token=…` | a viewer's terminal socket (below); 401 without a token, 403 refused |
| `GET /media/<session>?token=…` | a viewer's media socket on `screen-<monitor id>` (below); 401 without a token, 403 refused or viewing switched off, 404 no such screen |

The daemon's calls carry no token: the uplink is the sandbox's alone, and netd puts only viewer paths
(`/terminal/…`, `/media/…`) down it for a browser.

## Terminals

([`src/term/`](src/term)) Shells on a pseudo-terminal through portable-pty (wezterm's, MIT): ConPTY on Windows, openpty
elsewhere. On Windows `pwsh` where it is installed (on PATH or under Program Files), else Windows PowerShell; `cmd` and
`powershell` when asked for; `wsl.exe -d <distro> --cd <cwd or ~>` for `wsl:<distro>`. On Linux the user's login shell
(`$SHELL`, else the password database, run as `-bash`), or a shell `/etc/shells` lists when asked for by name, with
`TERM=xterm-256color`. A terminal outlives every viewer and the uplink dropping, for as long as remoted runs.

- **The socket is netd's terminal protocol exactly**: browser-wire's `TerminalClientMessage` in, `TerminalServerMessage`
  and the pane's bytes as binary messages out, `cols`, `rows`, `away=1` and `deflate=1` in the query, `ping`/`pong`, 45 s
  and 90 s silence rules, so the editor's terminal client opens one unchanged but for its URL. It also takes
  `{"type":"token","token":"…"}`: a fresh token keeping the socket's own access moves its expiry on.
- **Tokens** are castd's format ([`src/token.rs`](src/token.rs), castd's test vector holds the two equal) with `s =
  terminal/<session>`, signed under the uplink's media key; `ro: true` makes a watcher, whose typing is dropped and whose
  size bounds nothing. A socket outlives its newest token by `MEDIA_TOKEN_GRACE_SECONDS` (600 s) and is then closed with
  4002; a drop closes it with 4001. A debug build reads a shorter grace from `INTENTIC_REMOTED_TOKEN_GRACE_MS`, which the
  end-to-end test ("Measured end to end") uses to see a socket closed for its token and another kept by a fresh one.
- **One hub per terminal** ([`src/term/session.rs`](src/term/session.rs)), a single task, so a joining viewer's snapshot
  is cut exactly where its live output resumes. The grid is netd's rule: the per-axis minimum over the viewers in sight
  that may type, recomputed on join, resize, `away` and leave, applied to the pseudo-terminal only when it changes; with
  none in sight it stays. A viewer 1 MiB behind drops its backlog and, once its socket drained, is drawn a fresh snapshot.
- **The screen is kept by vt100** ([`src/term/screen.rs`](src/term/screen.rs)), 5,000 lines of history: a snapshot is a
  reset, the history scrolled into the viewer's scrollback, the screen, the cursor and the input modes (an alternate
  screen as the alternate screen). remoted is the terminal the program talks to: it answers the status and cursor-position
  queries (`ESC[5n`, `ESC[6n`) itself and keeps them from the viewers, so the answer is typed once however many watch.
  (2026-11-20) ConPTY asks for the cursor position as it starts (portable-pty opens it with
  `PSEUDOCONSOLE_INHERIT_CURSOR`) and holds the program's output until it is answered, so a terminal created before any
  viewer attached would otherwise hang. vt100 was chosen over alacritty_terminal for its formatted-redraw output, which is
  the snapshot; the cost is that a scroll region and the title are not re-sent.
- A program's exit ends the terminal, its viewers sent `exit` with its code; output still on its way is waited for until
  the pseudo-terminal is quiet 200 ms, 2 s at most (a ConPTY reader ends only once the pseudo-console is closed).

(2026-11-20) Rejected: one remoted per sandbox link (the design's `--sandbox-url` alone). A PC is linked to many
sandboxes, and two daemons would each hold the screen and its input in phase 2; one process with an uplink per link keeps
one owner of both. Rejected: building the tunnel's WebSocket and yamux plumbing again; the tunnel crate is depended on
by path, which brings quinn into the binary (about a megabyte) in exchange for netd's own liveness rules.

## Measured

`cargo test --test terminal -- --ignored --nocapture measure` against release builds (the Windows one from
`build-remoted.sh`; the Linux one glibc, where the shipped one was static musl until 2026-11-21), named to the suite through
`CARGO_BIN_EXE_intentic-remoted`, with a fake sandbox on loopback; keystroke echo is the round
trip through both yamux ends, the hub and the shell. 2026-11-20:

| | Windows 11, ConPTY, pwsh 7 (omen) | Linux, `/bin/sh` (Debian 13, z440) |
|---|---|---|
| uplink up after start | 69 ms | 53 ms |
| shell at its prompt after the create | 0.46 s | 8 ms |
| keystroke to its echo, median / p90 / worst of 20 | 15.7 / 16.2 / 28 ms | 0.70 / 0.76 / 0.90 ms |
| 20,000 lines printed and drawn | 3.4 s (`1..20000`) | 0.11 s (`seq`) |
| a second viewer drawn the screen and its 5,000 lines of history | 19 ms | 42 ms |

The Windows echo is ConPTY's own frame pacing (it renders about every 16 ms), and the long print is pwsh writing through
it; neither is remoted's. A `wsl:archlinux` terminal opened from the Windows side and answered in 1.3 s (debug build).
The release binaries are 4.8 MB (Windows, C runtime linked in) and 4.5 MB (Linux, glibc).

### Measured end to end

(2026-11-20) The whole path a person's keystroke takes, on the real binaries:
[`remote-terminal-netd.integration.test.ts`](../../_sandbox/sandbox/src/hosts/remote/remote-terminal-netd.integration.test.ts)
in the sandbox package starts the real netd and this remoted (debug builds), registers the device over netd's control
socket as the daemon does, opens a viewer's WebSocket at `/system/device-terminal/<device>/<session>` on netd's daemon
port, and times each keystroke from the WebSocket send to its echo arriving back: browser socket → netd → the yamux
uplink → remoted's hub → the pseudo-terminal (bash) and back, on loopback. Measured in an Intentic sandbox container
(Linux under WSL2 on rog), four runs of 20 keys each: median 0.51-0.68 ms, p90 0.62-1.03 ms, worst 1.21 ms. A typed
command's output arrives about 1 ms after its Enter. An uplink is up about 0.5 s after its config was rewritten, which is
remoted's half-second re-read of the file; a remoted started fresh reads it at once (69 / 53 ms above). The test also
runs in CI's netd-check job, which builds both binaries.

## Screens

([`src/media/`](src/media)) A person's view of one of this computer's monitors is browser-wire's media socket on
`/media/screen-<monitor id>`, message for message what castd serves for a sandbox window, from the same engine:
[cast-core](../../_sandbox/castd/crates/cast-core) does the capture loop, the shared encoder, rate control, paint-over,
the per-viewer flow and the peer connections, and a platform ([`media/platform.rs`](src/media/platform.rs)) brings
the monitors, the capture, the encoders and the input. Windows' is [`media/windows.rs`](src/media/windows.rs) on
[cast-win](../../_sandbox/castd/crates/cast-win) (DXGI capture, NVENC and Media Foundation encoders, SendInput,
WASAPI), whose README holds its measurements; Linux's is below.

- **One pipeline per monitor**, shared by every viewer of every uplink: opened on the first viewer, stopped 10 s after
  the last left (a reload rejoins it warm), and ended alone when its capture fails for good: its viewers are closed
  with 1011 and the reason, the next viewer opens it again, and remoted, its terminals and its other screens go on.
- **Who may do what**: the token's `s` is `media/<session>` under the uplink's key, as a terminal's; `allow.view` opens
  the socket, `allow.control` and the person's pause gate input (a viewer without them is a watcher); the socket is a
  person in the status line (`view` or `control`), and a drop or the view switch going off closes it with 4001.
- **Peer connections**: one UDP port for every screen, full ICE (cast-core's `rtc`, `Ice::Full`), started on the first
  viewer with the STUN servers the uplinks that allow viewing name (`iceServers`); with none named, host candidates
  only. The socket carries everything when no direct path opens. `INTENTIC_REMOTED_NO_RTC` turns peers off.
- **Windows' `/info`**: `screen` is `{mode: "dxgi", encoders, audio, session, secureDesktop, capture}`: `session` is
  what Windows says now (`locked`, `inputDesktop` (null: a secure desktop this process may not open), `display`
  `on`/`off`/`dimmed`, `console` and `session`, `connected`, `remote`, `idleMs`), `secureDesktop` is the service's
  status (below) and whether this remoted reaches its helper (`connected`), `capture` each screen's status by monitor.
- **Encoders** (Linux, [`encoders.rs`](src/media/linux/encoders.rs)): NVENC where an NVIDIA driver passes castd's
  self-test, then VA-API's (Intel, AMD, and D3D12 on WSL2; cast-core's `vaapi`), then the software encoder: openh264
  (BSD) in the default build, x264 (GPL) only behind the `x264` feature, for comparisons. Both hardware encoders'
  libraries are opened at run time, so the one binary runs with or without them. Each self-test runs once as remoted
  starts, in a child process (`encoder-probe`): a GPU driver may crash instead of failing (Mesa's d3d12 driver does,
  in its video processor and without a packed header), and a crash then costs that encoder (`the GPU driver crashed in
  the self-test (signal 11)`), not remoted. Every encoder that passed is tried in that order when a screen opens (a
  driver out of sessions), before openh264 takes the picture. `/info`'s `screen.encoders` says why each one is or is
  not used; `INTENTIC_REMOTED_ENCODER=software` leaves hardware out, `nvenc` or `vaapi` tries that one alone, and
  `CAST_VAAPI_VPP=1` gives VA-API BGRA to convert on the GPU (off: below, "Measured (Linux)").

### Linux

([`src/media/linux/`](src/media/linux)) Looked at again every 3 s; `/info`'s `screen.mode` says which case applies:

- **`x11`, a person's X11 session.** remoted is usually started without `DISPLAY` or `XAUTHORITY` (a systemd service,
  the agent at boot), so it reads them from the session's own processes ([`session.rs`](src/media/linux/session.rs)):
  those of its own user, or everyone's when it runs as root, the busiest session winning, GDM's and the home's cookie
  file when they name none. Every monitor RandR 1.5 lists is a screen (`screen-DP-1`), the X screen cropped to it,
  captured with MIT-SHM GetImage and XDamage, typed into with XTEST at the monitor's origin; the cookie is handed to
  cast-x11 (`connect::set_authority`) rather than set in the environment under running threads. The person's pointer
  stays drawn on their display, and the clipboard goes both ways.
- **`wayland`, a Wayland session (GNOME, KDE, wlroots)** ([`wayland/`](src/media/linux/wayland)). Xwayland's root
  shows only X clients, so the screen comes through the desktop portal on the session's bus (the session's own
  `DBUS_SESSION_BUS_ADDRESS`, else `$XDG_RUNTIME_DIR/bus`): one screen, `screen-wayland`, the monitor the person
  picks in the portal's dialog.
  - **Consent.** A viewer's open starts a RemoteDesktop session with a screen cast in it (`SelectDevices` keyboard and
    pointer, `SelectSources` one monitor, cursor as metadata, `Start`) with `persist_mode` 2. Without a restore token
    the portal asks the person at the computer; the open answers within 4 s that they are being asked, and `/info`'s
    `screen.consent` is `pending` (with `reason`), then `granted`; `refused` (not asked again for a minute, the
    viewer's error counting down), or `failed` (no portal, no ScreenCast: asked again on the next open). The restore
    token the portal hands back is kept 0600 in `$XDG_STATE_HOME/intentic-remoted/portal-restore-token` (else
    `~/.local/state/…`), rewritten after every start; `remembered` means one is kept and the next open will not ask.
    A token the portal no longer honours asks once more. Where the portal has no RemoteDesktop (wlroots), a screen
    cast alone, which leaves every viewer watching.
  - **The picture** ([`pipewire.rs`](src/media/linux/wayland/pipewire.rs)): `OpenPipeWireRemote`'s fd, a stream of
    32-bit RGB in shared memory (MemFd or MemPtr), converted to BGRX where the compositor sends another order, the
    compositor's damage list used where it sends one and otherwise row runs that differ from the last picture. The
    cursor is metadata: its shape and position go to viewers (`cursor`, `pointer`), never into the picture.
  - **Input** ([`input.rs`](src/media/linux/wayland/input.rs)): pointer motion in the stream's logical coordinates
    (`NotifyPointerMotionAbsolute`, scaled from picture pixels on a scaled monitor), buttons as evdev codes, wheel
    notches (`NotifyPointerAxisDiscrete`, 120 picture pixels a notch as on X11), and keys by the viewer's physical
    `code` (`NotifyKeyboardKeycode`, [`keycodes.rs`](src/media/linux/wayland/keycodes.rs)), so the person's own
    layout applies; a key with no physical code, an AltGr character and an IME's text go by keysym. Mutter (GNOME 48)
    drops a remote desktop session's first key event, so a `KEY_UNKNOWN` press, which types nothing, goes first.
  - The portal session ends with the screen (its last viewer gone 10 s), which takes GNOME's "sharing" indicator off
    the person's screen; stopping the share from that indicator ends the screen (`the screen cast ended`) and the next
    viewer's open restores it with the token. Not wired yet: the clipboard (the portal's Clipboard interface) and more
    than one monitor. remoted must run as the session's user: a session bus takes no other uid.
- **`virtual`, no display at all** ([`desktop.rs`](src/media/linux/desktop.rs)). The first viewer starts an X
  server (Xvfb `-shmem`, or Xorg with the dummy driver where Xvfb is absent) at 3840x2160, sized down to 1920x1080 and
  then to the driving viewer's box through RandR, and on it the desktop session installed (Xfce first; GNOME and KDE
  last, since they want OpenGL), else a window manager there is, as remoted's user, with a cookie of its own in
  `$XDG_RUNTIME_DIR/intentic-remoted`. It is captured in place from Xvfb's framebuffer, exactly as castd captures the
  sandbox's desktop. The desktop outlives its viewers (windows stay where they were) and ends with remoted, or when its
  session exits; a session that exits at once is an error with its last words. What is missing is named per
  distribution in `screen.missing` (`["xvfb", "xfce4"]` on Debian) and `screen.reason`; remoted installs nothing.

(2026-11-20) The X server and the session are started from a thread kept for the desktop's life: `PR_SET_PDEATHSIG`,
which ties them to remoted, fires when the forking *thread* ends, and tokio retires an idle blocking thread after 10 s,
which killed the desktop under its viewer on z440.

(2026-11-21) Decisions:

- **libpipewire is opened at run time**, its dozen calls and structs written out by hand from PipeWire 1.0's MIT
  headers, and SPA's PODs built and read by hand ([`pod.rs`](src/media/linux/wayland/pod.rs): libspa's builders are
  inline functions a library opened at run time does not have). Rejected: the `pipewire` crate, which needs
  libpipewire's headers to build and links it, so a computer without PipeWire would not start remoted at all. The cost
  is the layouts to keep (a test holds their sizes) and no PipeWire API newer than 0.3's stream. D-Bus is zbus, pure
  Rust, on remoted's tokio runtime.
- **Shared memory, not DMA-BUF**, for now: the compositor copies the picture to memory on its side. DMA-BUF frames
  handed to VA-API without a CPU copy need VA-API's video processor (BGRx in, NV12 out) to take them, and the only
  VA-API driver these computers have (Mesa's d3d12, WSL2) crashes in it, FFmpeg's `scale_vaapi` too; no Intel or AMD
  machine with a Wayland session was there to build it against. The same holds for X11 through DRI3.
- **No polling for WSLg.** WSLg's rootless Xwayland reports no damage on its root window, but a distro's remoted serves
  no screen (the sandbox offers a PC's screen from its Windows side, whose duplication shows WSLg's windows), so
  polling would cost a full copy and comparison a frame for a screen nobody opens.
- **The Linux release is glibc 2.28** (`build-remoted.sh`, cargo-zigbuild), linking only libc: a static musl binary
  cannot `dlopen`, so the shipped musl build never reached NVENC either (only glibc builds were measured with it).

### Measured (Linux)

`cargo test --release --test screen -- --ignored --nocapture measure`, the suite and a release remoted copied to the
computer: a fake sandbox's uplink on loopback, one viewer acking every frame as soon as it arrives, a 1920x1080
virtual desktop, 10 s of each motion. Latency is from capture to the frame's arrival at the viewer, encoding included.
2026-11-20, z440 (Debian 13, Xeon E5-1620 v4, 4 cores at 3.5 GHz, no GPU driver), openh264:

| | frames/s | kbit/s | capture to arrival, p50 / p95 | remoted CPU |
|---|---|---|---|---|
| a 400x300 box moving at 60 Hz (a window dragged) | 67 | 204–324 | 21 / 29 ms | 100% of a core |
| the whole screen repainted at 30 Hz | 50 | 1,950 | 46 / 71 ms | 160% of a core |

Frames per second count the paint-over passes that sharpen what stopped moving, hence more than the 60 Hz drawn. The
desktop started (Xvfb and openbox) and the first frame arrived 0.9 s after the socket opened.

2026-11-21, the release build (glibc 2.28) and the suite cross-built with it, 10 s of each motion, one viewer acking
every frame. "X11" is an X server remoted reads as a person's (`REMOTED_MEASURE_DISPLAY`: MIT-SHM GetImage and
XDamage), here a scratch Xvfb started without `-shmem`; "Wayland" is the portal path (`REMOTED_MEASURE_SCREEN=wayland`)
on a headless GNOME 48 (mutter 48.7, llvmpipe, PipeWire 1.4.2, xdg-desktop-portal-gnome) in a Debian 13 container on
rog, painted through its Xwayland. A Wayland frame's capture time is its arrival from PipeWire, so the compositor's
own latency is not in it, and GNOME composited at most about 43 frames a second under llvmpipe there.

| Computer | Screen | Encoder | Box dragged at 60 Hz: fps, kbit/s, p50 / p95, CPU | Whole screen at 30 Hz: fps, kbit/s, p50 / p95, CPU |
|---|---|---|---|---|
| z440 (Xeon E5-1620 v4, 4 cores) | X11 1920x1080 | openh264 | 68, 324, 21 / 27 ms, 96% | 49, 1,924, 49 / 64 ms, 153% |
| z440 | X11 2560x1440 | openh264 | 56, 201, 47 / 59 ms, 125% | 28, 2,446, 91 / 169 ms, 155% |
| radarsu-server (VM, 2 vCPUs of a Xeon E5-2667 v4) | X11 1920x1080 | openh264 | 57, 296, 35 / 71 ms, 121% | 31, 1,537, 70 / 141 ms, 148% |
| radarsu-server | X11 2560x1440 | openh264 | 40, 172, 56 / 116 ms, 125% | 20, 1,840, 97 / 190 ms, 153% |
| rog (WSL2 Arch, 16 cores, RTX 5080 Laptop) | X11 1920x1080 | NVENC | 64, 88, 7 / 20 ms, 9% | 60, 709, 20 / 24 ms, 13% |
| rog | X11 1920x1080 | VA-API (d3d12, the RTX) | 64, 85, 8 / 19 ms, 9% | 60, 712, 19 / 25 ms, 14% |
| rog | X11 1920x1080 | openh264 | 65, 318, 9 / 20 ms, 38% | 60, 2,171, 23 / 26 ms, 73% |
| rog | X11 2560x1600 (its panel) | NVENC | 65, 115, 15 / 29 ms, 13% | 60, 1,277, 29 / 33 ms, 26% |
| rog | X11 2560x1600 | VA-API (d3d12, the RTX) | 64, 112, 14 / 25 ms, 13% | 60, 1,753, 22 / 28 ms, 28% |
| rog | X11 2560x1600 | openh264 | 66, 208, 17 / 26 ms, 72% | 48, 3,425, 53 / 60 ms, 114% |
| rog (GNOME container) | Wayland 1920x1080 | openh264 | 43, 253, 6 / 8 ms, 31% | 30, 1,717, 11 / 12 ms, 37% |
| rog (GNOME container) | Wayland 2560x1440 | openh264 | 43, 179, 10 / 12 ms, 52% | 30, 2,788, 18 / 19 ms, 62% |

- **z440 has no hardware encoder to use**: its Quadro P2000 runs on nouveau, whose VA-API driver decodes only; NVENC
  needs NVIDIA's driver, which is the owner's to install. radarsu-server has neither a GPU (a virtual display only, no
  render node) nor a session. Neither has a desktop: Xvfb, xkbcomp and their libraries were unpacked from the
  distribution's own packages into a scratch folder (`apt-get download`, nothing installed), Xvfb's built-in
  `/usr/bin` for xkbcomp patched in its copy to the scratch path, and all of it removed afterwards. On both, openh264
  at 1440p and above and on 2 vCPUs is where full-screen motion stops keeping up.
- **VA-API on rog** is Mesa's d3d12 driver (Mesa 26.2.7, libva 2.24) on the RTX 5080, picked with
  `MESA_D3D12_DEFAULT_ADAPTER_NAME=NVIDIA`: on the Intel iGPU, which it picks by default, the driver encodes nothing
  (FFmpeg's `h264_vaapi` neither), and remoted's probe says so and leaves it out. Its video processor crashes (so does
  FFmpeg's `scale_vaapi`), which is why BGRA in is off by default. No Intel (iHD) or AMD (radeonsi) driver was
  reachable: those are the encoders VA-API is for, and they are not measured.
- **The portal on GNOME 48**: the first open asked (the "Remote Desktop" dialog, "Remember This Selection" ticked,
  "Allow Remote Interaction" off until the person turns it on); once allowed, every later open (gnome-shell restarted
  in between, at another size, included) was granted without a dialog, the first frame 140–220 ms after the socket
  opened. `wayland_input` (ignored, run by hand) moved the session's pointer (its position came back in the cursor
  metadata), clicked and typed `a`, `1` and Enter into an X window there. KDE and wlroots portals were not tried. z440 has neither Xvfb nor
a desktop, which `/info` said (`missing: ["xvfb", "xfce4"]`); for the measurement a Debian 13 Xvfb, xkbcomp and
openbox with the libraries z440 lacks were copied into a scratch directory and used through `PATH` (xkbcomp through an
overlay in a private mount namespace, Xvfb looking for it in /usr/bin only). On rog's Arch WSL (an
NVIDIA laptop GPU through WSL's driver) NVENC passed remoted's self-test in 2.5 s and a 2560x1600 screen opened on it;
no throughput was measured there, since WSLg's rootless Xwayland reports no damage on its root window.

## The lock screen and admin prompts (Windows)

([`src/service/`](src/service/mod.rs)) A process in the person's session cannot see or type into Windows' secure
desktop: the credential screen of a sign-in or a lock, a UAC prompt, Ctrl+Alt+Del. Opt-in, one administrator's yes:
`intentic-remoted service install --client <the agent's remoted>` (the machine agent's `remoteService`, the editor's
"Lock screen and admin prompts" row) makes this binary a Windows service as well.

- **The service** (`IntenticRemoted`, LocalSystem, automatic) runs from its own copy in
  `%ProgramData%\Intentic\Remoted\bin`, a folder only SYSTEM and administrators may write, so no program of the
  user's can change the code that runs as SYSTEM. It keeps one helper in the session on the computer's screen
  (`WTSGetActiveConsoleSessionId`, followed on session changes): its own token duplicated, moved into that session
  (`SetTokenInformation(TokenSessionId)`; there is no user token at a sign-in screen), started on `winsta0\default` in
  a job that ends it with the service. It writes a new 32-byte secret at each start, readable only by the user it was
  installed for (the owner of the `--client` binary). Ctrl+Alt+Del needs `SoftwareSASGeneration` to allow services:
  install sets it to 1 if it did not, and records what it was, which uninstall puts back. Its log is
  `%ProgramData%\Intentic\Remoted\service.log`, with the helper's lines in it.
- **The helper** (`desktop-helper`, SYSTEM) is a capture and input backend for remoted, not a second streaming stack
  (cast-win's `helper`): it listens on `\\.\pipe\intentic-remoted-desktop-<session>`, duplicates the monitors remoted
  asks for on whichever desktop takes input, shares each mirror texture with remoted's GPU device by an NT handle, and
  types remoted's input there; Ctrl+Alt+Del is a secure attention sequence it asks the service for. While a monitor is
  duplicated and a secure desktop shows, it draws a "Someone is connected" strip on it. It does nothing unless the
  person's remoted asks, and remoted runs only while one of the computer's remote switches is on and gates every
  viewer by them.
- **Who may talk to whom.** The pipe's access list names SYSTEM and that user only, and refuses remote clients. The
  helper accepts a process in its own session whose image is one of the installed `--client` paths and whose hello
  carries the secret. remoted accepts a pipe owned by SYSTEM or Administrators (which a process of the user cannot make)
  whose process runs from the service's binary. Nothing listens on a network.
- **remoted's screens** run on the helper whenever it is reachable ([`media/windows.rs`](src/media/windows.rs)),
  on their own duplication otherwise; a screen showing a placeholder because it cannot see its desktop checks every 2 s
  and hands over to a helper that appeared. With no service, a secure desktop is a placeholder saying why.
- **Removing it** needs no administrator when asked by the installing user's remoted: `service uninstall` run
  unelevated asks the service through its helper to remove itself (it marks itself for deletion, restores the policy,
  and a `cmd` it leaves behind deletes its folder once it ended). Taking a privilege away needs nobody's yes, and the
  person may not be at the computer. Elevated, `service uninstall` removes it directly. `--result <file>` writes the
  one-line answer to a file too, since an elevated run's output does not come back to the agent.
- **Administrator runs** (`service admin-run --status <file> [--cwd <dir>] [--grant <envelope>] -- <program>
  [<arg>…]`, [`windows/admin.rs`](src/service/windows/admin.rs)). The machine agent spawns this like any process when
  a `run_command` asks for `admin` and the owner said yes. The helper starts the program with the signed-in person's
  own elevated token in their session: `WTSQueryUserToken` for the session, then the linked token of the UAC split
  token (an account that is a full administrator already, with UAC off or the built-in Administrator, uses its own
  token; a standard user's is refused). That is what clicking Yes on a UAC prompt gives: their profile, HKCU and
  `%APPDATA%`, their environment (`CreateEnvironmentBlock`), any window on their desktop. A program named bare is
  looked up along the person's own PATH (the helper's is SYSTEM's), `.exe` first, and a relative path is the run's
  folder's.
  - It has its own pipe, `\\.\pipe\intentic-remoted-admin-<session>`, with the desktop pipe's access list, client
    check and secret, and the caller checks the pipe's server as remoted does. Any program of the installing user can
    pass those checks (by running the agent's remoted, which is the user's to start), so they are not what stands
    between a program of the user and an administrator's rights. The grant is.
  - **The grant.** Each run carries one (`--grant`): a payload `{kind: "admin-run", commandSha256, nonce, issuedAt,
    expiresAt}` and its Ed25519 signature over `intentic-admin-run/grant/v1`, a NUL and the payload, each base64url in
    a JSON envelope. The sandbox signs it with its keyring's signing key, the pair Passwords grants are signed with
    (under another domain string, so neither kind of grant stands for the other), once the owner said yes to that
    command. `service install --trust <key>` pins a sandbox's public key in `service.json` (`adminKeys`); a later
    install adds its key to those pinned before, so a second sandbox setting the service up keeps the first's runs. The
    helper starts nothing, and asks Windows for no token, until the grant verifies under a pinned key (`untrusted`
    when none is pinned), is an `admin-run` grant within its times (at most 5 minutes long, issued at most 30 s ahead
    of this clock, not expired), names a nonce no earlier run used (kept in memory until the grant's expiry), and
    covers exactly this command: `pwsh.exe` or `powershell.exe`, the machine agent's `-NoProfile -NonInteractive
    -ExecutionPolicy Bypass -Command` and the script whose SHA-256 it signed. PowerShell must also come from Windows
    PowerShell's folder or PowerShell's under Program Files, which only an administrator can change. Every refusal is
    in the log with its reason. A program of the user can reach the pipe, but it cannot sign a grant, and a grant it
    copies from the agent's command line runs the approved script and nothing else, once. The grant does not cover
    the run's folder.
  - The secure desktop's input path (cast-win's helper protocol on the desktop pipe) still rests on the older, weaker
    boundary: a program of the user that replaces or injects into the client remoted can drive it, and so can click
    Yes on a UAC prompt that is showing. Administrator runs no longer share that boundary.
  - stdout and stderr come back in chunks as the command writes them and go to the caller's own stdout and stderr; the
    caller exits with the command's exit code. The command runs in a job of its own (stdin is `NUL`). When the caller
    goes before the command ends (the agent's deadline killed it), the helper ends the job: the command and everything
    it started. After a normal end nothing is killed: what it started in the background keeps running, as with an
    unelevated `run_command`, and its output is collected for 2 s more at most. The command breaks away from the
    helper's job, so a helper started again (another session, an update) leaves it running.
  - Each run is in the service's log: the caller's process, the program, the first 200 characters of its arguments,
    the process started and its exit code.
  - `--status` gets one JSON line before the caller exits: `{"ran":true,"exitCode":<n>}`, or
    `{"ran":false,"reason":…,"error":…}` with exit code 125. `reason` is `not-windows`, `not-installed`, `outdated` (a
    service installed before administrator runs, whose `service.json` lacks `"features":["admin-run"]`),
    `not-running`, `unreachable`, `refused` (the helper refused this remoted, or the run's grant), `untrusted` (the
    service pins no sandbox key), `nobody-signed-in`, `not-administrator`, `start-failed` or `lost` (the pipe broke
    before the exit code came); `error` is a sentence a person can act on.
  - It uses its own pipe and protocol rather than cast-win's: a change to cast-win's helper protocol makes every
    installed service refuse remoted until someone sets it up again through a UAC prompt.
- `service status` needs no administrator: `{supported, installed, state, version, binary, clients, helper: {session,
  pid, desktop}, adminRuns, adminKeys}`, `adminKeys` the number of sandbox keys pinned.

(2026-11-20) The helper is a capture and input backend behind remoted rather than the screen backend itself (remoted
forwarding whole media sockets to a SYSTEM process). Measured on rog, a frame through the helper costs what one on
remoted's own duplication does (cast-win's README), and this way the viewers, tokens, switches, the pause, drops, the
status line, peer connections and the clipboard and sound (which are the person's session's) stay in one process; the
rejected shape would have put all of them, and the WAN transport being reworked beside it, behind the pipe too.
Rejected as well: the service running from the agent's folder under the user's profile, which any program of the user
could have replaced with code that then ran as SYSTEM.

(2026-11-23) Administrator runs start the command with the signed-in person's elevated token through the helper.
Rejected: an agent clicking Yes on the UAC prompt through the screen, which is consent nobody gives, depends on a
picture of a dimmed secure desktop, and cannot tell whose prompt it is answering. Running the command as SYSTEM, where
a per-user install lands in the system profile instead of the person's, and a window opens in session 0, where nobody
sees it. Adding the run to cast-win's helper protocol, whose new version would have made every PC's service refuse
remoted until it was set up again through a UAC prompt. Trusting the caller's process for the run (its image, its
session, the secret), which any program of the installing user can satisfy by starting the agent's remoted: each run
carries the sandbox's grant for its exact command instead.

## Testing on Windows

The suite runs a built `intentic-remoted` against a fake sandbox with real shells, so on Windows it exercises ConPTY,
pwsh and `wsl.exe`. Cross-built here and run on a Windows PC:

```sh
cargo xwin test --no-run --target x86_64-pc-windows-msvc   # then copy intentic-remoted.exe and the terminal-*.exe beside it
.\terminal.exe --test-threads=1                             # on the PC; add `--ignored wsl` for a distro's terminal
```

`tests/screen_windows.rs` runs the screens the same way (`CARGO_BIN_EXE_intentic-remoted` naming the remoted): a
monitor streamed at its native size with its `/stats` status and a screenshot, and the same through the helper, run by
hand as the user from a folder standing in for the service's (`INTENTIC_REMOTED_SERVICE_HOME`; no administrator, and
so no secure desktop). Ignored: `measure` (with `REMOTED_MEASURE_PATTERN` naming cast-win's `pattern.exe`,
`REMOTED_MEASURE_SIZE` its window, `REMOTED_MEASURE_HELPER=1` through the helper), and `drive`, a person scripted
(`REMOTED_DRIVE`: `shot:<name>`, `wait:<ms>`, `key:<Key>[:<Code>]`, `type:<text>`, `cad`, `click:<x>,<y>`, screenshots
into `REMOTED_SHOTS`), which with the real service installed is how the secure desktop was tried.

## Key files

- [src/uplink.rs](src/uplink.rs) — dialling a sandbox, the backoff, and serving the yamux streams it opens.
- [src/http.rs](src/http.rs) — every route on a stream, the token check and the terminal socket's upgrade.
- [src/term/session.rs](src/term/session.rs) — one terminal: its pseudo-terminal, the shared grid and the viewers' hub.
- [src/term/screen.rs](src/term/screen.rs) — the screen remoted keeps, its snapshot, and the queries it answers itself.
- [src/daemon.rs](src/daemon.rs) — the configuration as it stands, enforced: switches, drops and the pause.
- [src/media/mod.rs](src/media/mod.rs) — the screens: one pipeline per monitor, the media socket's route, its guard, the peer port.
- [src/media/linux/mod.rs](src/media/linux/mod.rs) — which Linux case this computer is, its monitors, opening one.
- [src/media/linux/desktop.rs](src/media/linux/desktop.rs) — the virtual desktop: its X server, its session, what is missing.
- [src/media/linux/encoders.rs](src/media/linux/encoders.rs) — NVENC, VA-API, openh264: each hardware self-test in a
  child process, the order they are tried in.
- [src/media/linux/wayland/mod.rs](src/media/linux/wayland/mod.rs) — a Wayland session's screen: consent, the portal
  session's life, the stream as a screen source.
- [src/media/linux/wayland/portal.rs](src/media/linux/wayland/portal.rs) — the desktop portal over zbus, the restore
  token.
- [src/media/linux/wayland/pipewire.rs](src/media/linux/wayland/pipewire.rs) — libpipewire at run time, the stream,
  the capture and the cursor metadata.
- [tests/terminal.rs](tests/terminal.rs) — the binary end to end against a fake sandbox's uplink.
- [src/service/mod.rs](src/service/mod.rs) — the lock screen and admin prompts service: install, the SYSTEM helper, who
  may talk to it.
- [src/service/windows/admin.rs](src/service/windows/admin.rs) — administrator runs: the elevated token, the process
  and its job, the output relay, and `service admin-run`; [src/service/admin.rs](src/service/admin.rs) holds their
  protocol, the command line's quoting and the status line.
- [tests/screen.rs](tests/screen.rs) — a screen end to end on an Xvfb of the suite's own, a virtual desktop, a peer
  connection through the uplink's STUN servers, and `measure`.

## Commands

```sh
cargo test --manifest-path _devices/remoted/Cargo.toml   # the screen tests need Xvfb, else they stand down
# On a Wayland session (its bus in DBUS_SESSION_BUS_ADDRESS, its Xwayland at REMOTED_MEASURE_DISPLAY with XAUTHORITY);
# the first run waits for the person to allow sharing:
REMOTED_MEASURE_SCREEN=wayland cargo test --manifest-path _devices/remoted/Cargo.toml --test screen -- --ignored --nocapture measure
cargo test --manifest-path _devices/remoted/Cargo.toml --test screen -- --ignored --nocapture wayland_input
cargo xwin clippy --manifest-path _devices/remoted/Cargo.toml --all-targets --target x86_64-pc-windows-msvc
bash _tools/scripts/build/build-remoted.sh [--version <v>] linux-x64 linux-arm64 windows-x64
```
