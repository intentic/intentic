# A sandbox browser as a local-feeling window: analysis

> **Status: phases 1 and 2 implemented (2026-09-17)** in `_sandbox/sandbox/src/browser/cast/` (`region.ts`,
> `stills.ts`, the reworked `live-view.ts`/`videocast.ts`), `browser-sessions.ts` (dialogs held, popups placed) and
> `_editor/web/src/features/browsers/` (the pane's own tabs, address bar and navigation; keyboard via CDP; stills;
> the local pointer; resize-follow). Not yet: the desktop app's own browser window (phase 3), the co-driving overlay
> and wheel ownership at the router (phase 4), a native context menu, uploads from the owner's disk and the download
> shelf (§4.6, the file half), history-backed suggestions.

**Question.** The agent's browser runs headed inside the sandbox container, and the owner watches it as a video
of its X display. That is a stream, and it feels like one. Can the owner instead get what reads as a normal local
browser on Windows — tabs, address bar, navigation, dialogs, uploads and downloads, shortcuts, a window that
resizes — while the browser process, its profile and every byte of its network traffic stay in the container,
and the Windows side is only a thin shell (a WebView), with no browser installed on the host for it?

**Verdict.** Yes, and the shape is fixed by one constraint rather than by taste: the agent and the owner must
share ONE browser (same cookies, same tabs, same page state), and that browser must exist when no Windows shell
is open (turns, automations, hosted sandboxes). So the renderer is the container's Chromium and the shell can
only ever show a *picture* of page content. Everything that is **not page pixels** can be local, and that is
exactly the list that makes a browser feel like a browser: the tab strip, the address bar and its suggestions,
back/forward/reload, JS dialogs, the file picker, the download shelf, find, zoom, keyboard shortcuts, the cursor,
and the window's size. All of it is driven by the Chrome DevTools Protocol, which the daemon already speaks to
that browser, from the shell that already exists (the Tauri desktop app's floating panels, or the SPA's own
pane). The picture stays what it is today — H.264 off the browser's X display over the daemon's WebSocket — but
**cropped to the page viewport**, sized to the shell's window, with a **lossless still overlaid whenever the page
settles** (crisp text when a person is reading) and the **pointer drawn locally** (the hand-eye loop stops being
remote). Nothing in this needs WebRTC, a window manager, a VNC server, or a new native dependency; every new
piece is CDP, which Playwright pins by construction. The two rejected families — local rendering with proxied
network (WebView2 as the real browser), and DOM mirroring — are documented in §8 with the reasons.

One defect found on the way is worth fixing before anything else: the daemon's own CDP attach to the agent's
browser **dismisses every JavaScript dialog the agent's page opens** (§1.6, confirmed at runtime), so
`browser_handle_dialog` cannot work once the daemon is watching.

Analysis date: 2026-09-17. Scope: the sandbox daemon (`_sandbox/sandbox/src/browser/`), the editor
(`_editor/web/src/features/browsers/`) and the desktop app (`_editor/desktop-app`). Measured on this sandbox
(16 threads, Xvfb + Chromium 151 + ffmpeg 7.1) and on the owner's ROG (24 threads, Edge/WebView2 153, a
3840×2160 panel).

---

## 1. What runs today, and what is actually poor about it

`browser-tools.ts` launches `@playwright/mcp`'s Chromium **headed** on a private Xvfb display (`display.ts`,
1280×880, one per browser, no window manager), with `--remote-debugging-port`. `browser-sessions.ts` attaches
the daemon to it over CDP with a second Playwright client, to list pages. Watching (`live-view.ts`) is ffmpeg
`x11grab` of the whole display → libx264 ultrafast/zerolatency, 30 fps, CRF 24, one encoder per viewer →
one WebSocket message per access unit → `VideoDecoder` (WebCodecs) → a canvas (`useBrowserView.ts`,
`videoSink.ts`). Input goes back as JSON and is replayed by one long-lived `xdotool -` process (XTEST) on that
display (`xinput.ts`). The CDP screencast path (`screencast.ts`) remains only for a browser with no display.

The design note in `subsystems.md` explains why the whole window is in the picture: `<select>` menus, autofill,
the file picker, permission bubbles and Chromium's own chrome are separate X windows outside the page's
compositor, so photographing the display made them visible and clickable and let an earlier HTML address bar
and a drop-down reimplementation be deleted. That reasoning is correct and this analysis keeps the display grab.
What makes it *feel* streamed is a different list:

1. **A fixed 1280×880 picture, scaled to whatever pane it lands in.** On the owner's 3840×2160 panel that is a
   ~2× upscale of a 4:2:0 H.264 image: text edges smear (chroma is quarter-resolution) and everything is soft.
   The size cannot follow the window; the page cannot be seen at the owner's own DPI.
2. **The browser's chrome is inside the picture.** Every keystroke into the address bar is a round trip, there
   are no local suggestions, and a chord meant for the browser (`Ctrl+L`, `Ctrl+T`, `Ctrl+W`) either collides
   with the host's shortcut or drives an omnibox the owner may not be able to read.
3. **The cursor is drawn remotely** (`-draw_mouse 1`). The pointer is the one thing a person's hand is attached
   to; when it lags, the whole surface reads as remote even at 60 ms glass-to-glass.
4. **No backpressure.** `videocast.ts` hands every access unit to `sink.send` unconditionally. On a slow link the
   socket buffer fills, and the picture drifts seconds behind the pointer with no recovery short of a reconnect.
5. **Grab cost is pixel×fps-bound, not change-bound.** `x11grab` reads the whole framebuffer 30 times a second
   whatever changed. Measured (§6): 0.15 core for a *static* page at 1280×880, 0.6 core at 2560×1600. Video
   at the owner's real resolution would cost that per viewer, all the time the pane is visible.
6. **Dialogs are silently dismissed.** Playwright's client auto-dismisses a JS dialog when nobody listens for it
   (`coreBundle.js:61869`: `if (!hasListeners) dismiss/accept`). The daemon's `connectOverCDP` attach registers
   no `dialog` listener, so from the moment it attaches — the first browser tool call — every `alert`, `confirm`,
   `prompt` and `beforeunload` in the agent's browser is closed before the MCP's own listener can hold it.
   Verified: with one client listening, `alert()` stays open; the moment a second listener-less client attaches
   over CDP, the same `alert()` returns immediately. `browser_handle_dialog` cannot work while a browser is
   listed in the daemon, i.e. always.
7. **No window manager, and nothing standing in for one.** `window.open` with size features opened at (0,0) as a
   1280×914 window — larger than the 880-high grab region, features ignored — squarely over the main window
   (measured, §6). OAuth popups therefore appear as an unframed sheet the owner cannot move or close except by
   keyboard, and its bottom 34 px are outside the picture.
8. **Files are the container's.** The file picker is the container's GTK dialog over `/work`; a download lands
   in the container with no way to the owner's disk; there is no way to upload a file from Windows.
9. **Keyboard through xdotool.** `type` maps characters to keysyms through temporary keymap changes (~12 ms per
   character by default), `--clearmodifiers` guesses at modifier state, there is no IME path, and a key chord
   goes wherever X focus is — which after a new blank tab is Chromium's omnibox, not the page.
10. **The pane cannot leave the editor.** The desktop app floats chat, terminal and preview into windows of their
    own; the Browsers pane is not one of them, so the browser can never be alt-tabbed to as a window.

None of these is the transport. Points 1–5 are the picture and the input model; 6–8 are ownership of things
that are not pixels; 9–10 are the shell. That is the order this analysis fixes them in.

## 2. The constraint that decides the shape

The agent drives the browser through `@playwright/mcp` in the container, in a turn that may run at 03:00 from
an automation, on a hosted Fly machine, with the owner's laptop closed. The owner's actions and the agent's must
land on the same cookies, the same tabs, the same half-filled form. Therefore:

- **The renderer is the container's Chromium.** A Windows-side engine could only ever be a *second* browser.
- **What the shell shows of a page is a picture**, however it is produced. The freedom is in what is a picture and
  what is local, how the picture is made and moved, and how input goes back.
- **"As if a normal local browser" is achievable for everything that is not page pixels**, and a local browser is
  mostly those things: the tab strip, the omnibox and its suggestions, navigation, dialogs, the picker, the
  shelf, find, zoom, shortcuts, the cursor, the window. Each has a CDP source of truth.

That is the whole argument. What follows is which picture, which input, and where each non-pixel thing lives.

## 3. The options, compared

| | Option | Picture | Chrome | Verdict |
|---|---|---|---|---|
| A | Today's display video, improved in place (size follows window, local cursor, backpressure, stills) | whole display | in the picture | the floor; every item is also part of B |
| **B** | **Native shell chrome over CDP + display video cropped to the viewport + lossless stills** | display, cropped | shell, from CDP | **recommended** |
| C | WebRTC transport (neko / Selkies / GStreamer `webrtcbin`) | as A or B | as A or B | not now: it changes the wire, not the experience (§8) |
| D | KasmVNC / Xvnc (damage-based tile encoder, lossless refresh) | Xvnc's own | in the picture | the fallback if grab CPU bites (§5.4) |
| E | DOM mirroring rendered locally (rrweb-style co-browsing) | local DOM | shell | rejected: unbounded fidelity gaps (§8) |
| F | WebView2 is the real browser; network proxied into the container; agent drives it over CDP | local engine | native | rejected: violates §2; a second browser (§8) |
| G | New-headless Chromium + `Page.startScreencast` per tab | compositor | shell | rejected: WAF fingerprinting (the pack's own finding), `<select>`/popup gap, JPEG bandwidth |

B is A plus one decision — the shell owns the chrome — and that decision is what turns a remote desktop into a
browser. It is also the one that removes work: the picture no longer needs to carry Chromium's tab strip and
omnibox, and the input path no longer needs XTEST for keyboard at all.

## 4. The recommended architecture

### 4.1 The picture: the display grab, cropped to the page viewport

Keep `x11grab` of the whole display; it is the only capture that shows a native `<select>`, the context menu,
autofill, a permission bubble, the basic-auth prompt and a `window.open` popup, because on the display they
are X windows (measured: an open `<select>` is a separate 30×50 window at its own coordinates). Send the crop
rectangle with `ready`: the viewport's position inside the window, read at runtime as
`outerHeight − innerHeight` (87 CSS px on this Chromium, 174 device px at DSF 2 — read, never hard-coded; it
moves with Chromium versions and flags). The client draws only the crop (`drawImage` with a source rectangle,
free) and maps pointer coordinates back by adding the offset. Chromium's own chrome is still rasterised and
encoded — a static band x264 compresses to nothing — and never shown.

Two things extend beyond the viewport and must be handled, not hoped away:

- **Bubbles anchored to the toolbar** (permission prompt, zoom bubble, find bar) hang *down into* the content
  area, so their body is inside the crop. Their anchor is not. Acceptable for v1; §4.6 moves the ones that
  matter to CDP so they never appear.
- **Fullscreen** (`requestFullscreen`, a video player) makes the window fill the X screen. There is no CDP
  event for it; the init script already injected on every document (`stealth.ts`) adds a `fullscreenchange`
  listener calling a `Runtime.addBinding` function, and the view switches to an uncropped, full-screen crop
  rectangle and back. Deterministic, page-derived.

### 4.2 Crisp when it matters: a lossless still whenever the page settles

Video at 4:2:0 is the right thing while something moves and the wrong thing while someone reads. The frames path
already solves this (`screencast.ts`: `STILL_DELAY_MS`, `STILL_SCALE = 2`, the capture-echo window, byte-identical
WebP comparison). Lift it onto the video path: after `STILL_DELAY_MS` without motion, `Page.captureScreenshot`
of the viewport at scale 2 (lossless WebP), overlay it on the canvas; the next decoded video frame that differs
replaces it. The echo logic exists because a capture disturbs the page's raster and the display grab sees that
disturbance; it is already written and tested (`screencast.stale.integration.test.ts`).

This is the answer to HiDPI and to chroma smear at once, at 1× encode cost: the page is captured at 2× when
still, which is when the owner is looking at text, and streamed at 1× when moving, when nobody can read anyway.
A 2560×1586 lossless WebP of a page is 300–800 kB; on the owner's own machine (the common case) that is nothing,
over a tunnel it is throttled to one per settle and never more than one every two seconds.

H.264 4:4:4 was measured as the alternative (§6): decodable in **software** on Edge/WebView2 153 but not in
hardware, and 2× the encode cost at 1280×880. Not worth it against stills; keep 4:2:0 baseline.

### 4.3 The size follows the shell window

Xvfb's screen is allocated larger than any window (e.g. 3840×2160, 33 MB of framebuffer) and the Chromium
window is sized to the shell's viewport with `Browser.setWindowBounds` — verified to work on a WM-less Xvfb
(1280×880 → 1800×1200 → 2560×1600, viewport following each time). The grab region follows the window, which
means restarting ffmpeg on resize: debounced to the end of the drag, ~200 ms of the last frame held, a fresh
keyframe on restart. No RANDR, no `xrandr`, nothing dynamic in the X server.

Device scale factor is a launch-time flag (`--force-device-scale-factor=2`) and quadruples grab cost (§6). It
stays a per-profile knob, off by default; §4.2's 2× stills give a 4K panel crisp text without it.

### 4.4 Input: pointer through XTEST, keyboard through CDP, chords never forwarded

- **Pointer → XTEST**, as today, in display coordinates (viewport coordinates plus the crop offset). This is what
  makes everything on the display clickable: the page, an open `<select>`, the context menu, a popup window.
- **Keyboard → CDP `Input.dispatchKeyEvent` / `Input.insertText`**, the path `screencast.ts` already has
  (`dispatchKey`, `SPECIAL_KEYS`, extended to a full key table). CDP key events go to the **page's** widget
  regardless of X focus, so a freshly opened blank tab whose omnibox took focus can no longer swallow typing;
  text arrives as exact Unicode (IME, dead keys, any layout) with no keymap remapping and no per-character delay.
- **XTEST keys only while a native popup owns the keyboard**: arrows/Enter/Escape in an open `<select>`, typing
  in Chromium's find bar. Both are page-derived facts, not guesses: after a `mouseup` the daemon already asks the
  page what is focused (`readSelect`), and the shell knows it sent `Ctrl+F`. The mode ends on `blur`/`change`/
  `Escape`.
- **Browser chords are the shell's and never leave it.** `Ctrl+T/W/Tab/L/R/F/+/−/0`, `F5`, `Alt+←/→`,
  `Ctrl+Shift+T` become CDP commands (§4.5). Forwarding them as keys was how a hidden omnibox got focus.
- **The cursor is local.** Capture with `-draw_mouse 0`; hide the X cursor; the shell draws its own, with the shape
  from the DOM under the pointer via the existing `cursorReporter` (throttled `elementFromPoint` → computed
  `cursor`). Pointer latency becomes zero; the remaining echo is typing and clicks, ~50–80 ms on the owner's own
  machine, which is a good remote desktop and, with a local pointer and local chrome, reads as a slightly slow
  page rather than a stream.

### 4.5 The chrome, from CDP

Everything below is a domain Playwright itself depends on, pinned by the `playwright` catalog entry; a Chromium
that broke one would break the agent's own tools first.

| Shell element | Source of truth | Action |
|---|---|---|
| tab strip, titles, loading spinner | `Target.setDiscoverTargets` events (already tracked in `browser-sessions.ts` as `PageRecord`), `Page.lifecycleEvent` | `Target.createTarget`, `activateTarget`, `closeTarget` |
| favicon | `<link rel=icon>` fetched **by the page** (`Runtime.evaluate` → data URL), cached per origin | — (network stays in the container) |
| address, padlock | `targetInfoChanged`, `Security.securityStateChanged` | `Page.navigate`; typed text without a scheme → the profile's search engine |
| suggestions | a per-profile history the daemon keeps (it sees every navigation; identity profiles persist) | — |
| back / forward / reload / stop | `Page.getNavigationHistory` (`canGoBack/Forward`) | `navigateToHistoryEntry`, `reload`, `stopLoading` |
| zoom | `Ctrl+±` via XTEST (browser-level; the bubble is in the cropped band) | — |
| find | shell UI over `Runtime.evaluate(window.find)` v2; Chromium's own bar via XTEST v1 | — |
| context menu | Chromium's own, in the picture, XTEST-clickable (v1); shell-native curated menu (v2) | — |

The tab strip and address line in `Browsers.vue` already exist, fed by session state; this section makes them
*the* strip and *the* address bar rather than a copy of what is in the picture.

### 4.6 Things that are not pixels: dialogs, files, permissions

- **JS dialogs.** The daemon becomes the one owner: a `dialog` listener on its client (which also ends the §1.6
  bug), the dialog rendered natively in the shell for the owner *and* held open for the agent's
  `browser_handle_dialog`. Whoever answers first closes it; Chromium reports the close to both clients.
- **File upload.** `Page.setInterceptFileChooserDialog` + `fileChooserOpened` (Playwright's `filechooser`).
  The shell offers a Windows picker — a plain `<input type=file>` in the SPA; WebView2 shows the native dialog,
  no Tauri plugin needed — uploads the bytes to a daemon scratch directory over the existing authenticated
  HTTP, then `setFiles`. The agent's `browser_file_upload` keeps working: interception is per client, both are
  notified, whoever sets files first wins, and a chooser nobody answers stays pending as it does now.
- **Downloads.** `Browser.downloadWillBegin` / `downloadProgress` events feed a shelf in the shell. The file lands
  in the container as now (it is the agent's world) with **Save to this computer**, streamed out through the daemon
  the way browser artifacts already are. One owner rule: the MCP already sets `Browser.setDownloadBehavior` for
  its `--output-dir`; the daemon observes events and does not set behavior.
- **Basic auth** stays in the picture for v1 (a constrained dialog centred on the content, inside the crop);
  `Fetch.authRequired` → native prompt is v2.
- **Permissions.** Pre-decide per profile with `Browser.setPermission` (deny notifications and MIDI, grant
  clipboard-read, ask nothing), so the bubble never appears. Geolocation and camera prompts become a shell card
  that calls `setPermission`; there is no CDP "permission requested" event, so the card is raised from the
  Permissions API polled in the injected init script — or, simpler, the bubble stays in the picture (§4.1).
- **Print** disabled (`--disable-print-preview`); nothing in a container prints.

### 4.7 Windows without a window manager

Every new window (`Target.targetCreated` with an `openerId`, or a `windowId` the daemon has not seen) is placed
with `Browser.setWindowBounds` to the main window's bounds, so a popup is a clean sheet over the page and the
shell shows it as a tab with a "popup" mark; closing the tab closes the window. Activating a tab that lives in
another window is `Target.activateTarget`, which raises that window — on a WM-less server nothing can refuse a
raise. If a Chromium version proves otherwise, `matchbox-window-manager` (a 200 kB kiosk WM whose only policy is
"every window fills the screen, newest on top") is the contained fallback; it is not proposed now because a
process nothing measured a need for is a process to keep alive.

### 4.8 Transport: the WebSocket stays, and learns to drop

WebRTC would give congestion control and no head-of-line blocking over a lossy WAN. It would also need a UDP
path (Fly's hosted lane replays HTTP only; Docker on WSL2 publishes UDP through two NATs), ICE candidates
that are not the container's own 172.x address, DTLS/SRTP and a TURN fallback — a second reachability lane to
keep working on every deployment shape the tunnel already covers. The primary case is the owner's own machine,
where TCP on loopback has neither loss nor bufferbloat. What the WebSocket lacks is one behaviour: **backpressure**.
Track the socket's buffered amount per viewer; above a threshold, drop delta frames until the next keyframe and
send that; shorten the GOP from 60 to 30 so the freeze under congestion is bounded at one second. Everything else
(pause when hidden, keyframe recovery, one encoder per viewer) exists. A fan-out encoder with keyframe-on-join
is a later optimisation, not a prerequisite.

### 4.9 The Windows shell is the app that exists

The desktop app already builds a window of its own for `/floating/<panel>` (`windows.rs`, `show_floating`), with
no platform frame, the page drawing its own bar, sharing the app's browser profile with the workspace window.
A browser is one more such panel: `/floating/browser/<session>`, label `floating-browser-<session>` — a small
generalisation of `floating_panel`, which today accepts one path segment. The page draws the tab strip and
omnibox (`Browsers.vue`, reshaped), the picture fills the rest, and `fit`/`raise`/`close` work through the
`intentic://window` links every floating panel already uses. Nothing else on the Windows side: no native tab
control, no WebView2-specific code. WebView2 has no tabs, so `Ctrl+T/W/Tab` are not reserved and reach the
page's `keydown`; `F5`, `Ctrl+F`, `Ctrl+P`, `Alt+←` are accelerators a page may `preventDefault`. Any that leak
are handled in Rust with wry's Windows extension (`with_browser_accelerator_keys(false)`); Tauri's builder does
not expose it directly, so that is one small `page_window` change if a chord is found to leak.

The same UI runs in the SPA's pane in a real browser tab, where `Ctrl+W` and `Ctrl+T` belong to the host — there
the pane offers **pop out**, and a page-level fallback (`navigator.keyboard.lock()` in fullscreen) for people who
stay in the tab.

### 4.10 Watching the agent, and taking the wheel

- **Presence.** The browser router sees every tool call (`browser_click` with its `ref` and `element`). The
  daemon resolves the ref to a box (`aria-ref=` locator → `boundingBox`) and sends `{type:"agent", action,
  rect, label}`; the shell draws a second, differently coloured cursor that glides to the target, a pulse on the
  click, and a one-line caption ("clicking *Sign in*"). Cheap, and it is the difference between watching a
  screen change and watching someone work.
- **Wheel ownership, enforced where it can be.** Three states: *watching*, *owner driving*, *agent asking for
  hands* (the existing help request). While the owner drives, the router answers the agent's browser calls with
  "the owner is driving this browser; wait for them to hand back" rather than letting two hands fight for one
  mouse. When the agent's help card is answered, driving ends (already the case).
- **Replay.** The client keeps a 30-second ring of decoded frames (a few MB); a scrubber under the picture answers
  "what did it just do" without any daemon support.

## 5. Fragility analysis: what can break, and how each is contained

| Dependency | What breaks | Containment |
|---|---|---|
| CDP domains (Target, Page, Input, Browser, Security, Runtime) | a Chromium revision changes an event | pinned by the `playwright` catalog entry, same revision as the agent's tools; the geometry spike (§6) becomes an integration test asserting chrome height, `setWindowBounds`, popup placement |
| chrome height / crop | a version or flag changes the toolbar | read at runtime per window (`outerHeight − innerHeight`), re-read on `Browser` bounds changes and on DSF |
| no window manager | a popup appears where not expected; a raise is refused | placement on `targetCreated`; measured fallback WM (§4.7) |
| `x11grab` CPU | a 4K-class viewport costs 0.6 core per viewer for a still page | pause when hidden (exists); 1× video + 2× stills instead of DSF 2; upgrade path: an XDamage/XShm grabber (a small C helper feeding ffmpeg) or KasmVNC's Xvnc, only if measured to matter |
| two Playwright clients on one browser | dialogs dismissed (today), download behavior overwritten, chooser interception raced | **one-owner rule per concern**: dialogs the daemon, downloads the MCP's `setDownloadBehavior` (daemon observes), choosers both may answer; a test per rule |
| `xdotool` | keysym mapping, modifier guessing, per-char delay, focus in the wrong widget | pointer only; keyboard via CDP; XTEST keys only in the two page-derived popup modes |
| WebCodecs | a client that cannot decode H.264 | exists today (Chrome/Edge/Safari 16.4+/Firefox 130+); WebView2 153 decodes baseline/main/high in hardware (measured) |
| transport | a slow tunnel | backpressure + 1 s GOP (§4.8); the WebSocket is already ticket-authenticated on every lane |
| fullscreen | crop rectangle wrong | page-derived binding (§4.1) |
| Chromium's omnibox taking focus | typed text vanishes | keyboard via CDP targets the page; chords never forwarded |
| dialog ownership with the agent | owner and agent both answer | Chromium closes once; both clients get the close; the second answer is a no-op |
| hosted lane | none of the above differs | the picture and input ride the same WebSocket that reaches a hosted sandbox through the Fly replay today |

Nothing above introduces a daemon, a server, a protocol or a build dependency that does not already exist in the
browser pack. The browser pack itself gains nothing.

## 6. Measurements

All on this sandbox unless noted; x264 `ultrafast`/`zerolatency`, baseline, CRF 24, 30 fps; "cores" is
user CPU time divided by wall time.

**Encode only** (synthetic worst-case motion source, 6 s):

| size | pixel format | cores | notes |
|---|---|---|---|
| 1280×880 | 4:2:0 | 0.09 | today's picture |
| 1920×1080 | 4:2:0 | 0.13 | |
| 2560×1760 | 4:2:0 | 0.28 | today's picture at DSF 2 |
| 1280×880 | 4:4:4 | 0.16 | High 4:4:4 profile |
| 2560×1760 | 4:4:4 | 0.86 | |
| 1280×880 still white | 4:2:0 | 0.05 | 40 kB for 6 s |

**Grab + encode off a real Xvfb with Chromium on it** (4 s):

| region | page | cores | bytes / 4 s |
|---|---|---|---|
| 1280×880 | static | 0.15 | 76 kB |
| 1280×880 | animated | 0.20 | 1.3 MB |
| 2560×1600 | static | 0.58 | 105 kB |
| 2560×1600 | animated | 0.66 | 3.0 MB |

The static-page rows are the finding: at 2560×1600 the grab itself is ~0.55 core before anything moves. Cost is
pixels × fps, not change. That is what §4.2 (2× stills instead of DSF 2) and §5's upgrade path are for.

**Chromium on a WM-less Xvfb** (2560×1600 screen, `--window-position=0,0 --window-size=1280,880`, `viewport: null`):

- viewport offset (toolbar height): **87 CSS px** at DSF 1 (`outer 880 → inner 793`); 87 CSS / 174 device px at
  DSF 2 (`--force-device-scale-factor=2`, X window 2560×1760).
- `Browser.setWindowBounds` 1280×880 → 1800×1200 → 2560×1600: the window and viewport followed each time
  (2559×1599 reported for the last — off by one, harmless).
- `window.open(url, "_blank", "width=500,height=400")`: a **separate X window at (0,0), 1280×914** — the size
  features were ignored and it is taller than the main window; it fully covers the main window.
- `window.open(url, "_blank")` with no features: a tab in the **same** window.
- An open `<select>` is its own visible X window (30×50 at DSF 1, 58×98 at DSF 2), positioned under the control.

**Decoders** (`VideoDecoder.isConfigSupported`, 1920×1080):

| codec | this Chromium 151 (software) | Edge/WebView2 153 on the ROG, hardware | …software |
|---|---|---|---|
| H.264 baseline / main / high | yes | yes | yes |
| H.264 High 4:4:4 (`avc1.F4002A`) | yes | **no** | yes |
| VP9 profile 0 | yes | yes | yes |
| AV1 main | yes | yes | yes |

WebCodecs is secure-context only (`VideoDecoder` is undefined on `about:blank`/`data:`); the app is served over
https or `localhost`, so this holds where it matters and was the reason the first probe failed.

**Dialogs with two clients** (Chromium headless, client A launched it and listens; client B is
`connectOverCDP` with no listener, the daemon's shape): A alone → `alert()` stays open; A + B → `alert()`
returns at once. B dismissed it.

**The owner's machine** (radarsu-rog): 24 threads, WebView2 runtime 153.0.4234.32, panels 1920×1200 (Intel)
and **3840×2160** (NVIDIA). The 4K panel is why §1.1 is the first-listed defect.

## 7. Phasing

Each phase ships on its own and is useful alone; none waits on the next.

1. **Feel** (daemon + SPA pane, no desktop change): local cursor (`-draw_mouse 0` + `cursorReporter`);
   backpressure and 1 s GOP; crop to the viewport with the existing strip/address line promoted to *the* chrome;
   lossless 2× stills on settle; window size follows the pane (`setWindowBounds` + ffmpeg restart). Fix §1.6 first:
   a `dialog` listener in `browser-sessions.ts` that shows the dialog in the pane and holds it for the agent.
2. **Own the chrome** (daemon + SPA): keyboard via CDP with a full key table and the two XTEST modes; chords → CDP
   commands; navigation history, suggestions, favicons; upload via the picker; download shelf with save-out;
   popup placement; fullscreen binding; permissions pre-decided.
3. **The window** (desktop app): `/floating/browser/<session>`; accelerator audit; pop-out from the SPA pane.
4. **Co-driving**: presence overlay, wheel ownership at the router, the replay ring.

The geometry, dialog and codec spikes from §6 become integration tests in phase 1 so that a Chromium bump that
moves the toolbar, changes popup placement or alters dialog dispatch fails a test rather than a session.

## 8. What was rejected, and why

- **WebView2 as the real browser, network proxied into the container (F).** Tempting because it is literally
  "a normal local browser" and the fingerprint is a real Windows Edge. It breaks §2 twice: the browser exists
  only while the owner's app is open (no automations, no hosted sandboxes, no turn at 03:00), and it is a second
  browser — the agent's cookies, tabs and half-filled forms would be on the wrong machine, or synced, which is a
  third problem. The workspace already has the legitimate version of this idea: `_devices/browser` drives a
  browser on the owner's own device as a *device* capability, for steps a remote browser cannot do (a passkey,
  a hardware key), and `webext` lends a signed-in session across. Those stay; they are not this.
- **DOM mirroring rendered locally (E).** Native text, resize, selection, accessibility — and canvas, WebGL,
  video, closed shadow roots, cross-origin iframes, CSS animation state, focus, scroll sync, JS-driven layout,
  and every anti-bot check that compares the two. Co-browsing products that do this employ teams to chase the
  gaps. The `_editor/web` README already records abandoning "a synced picture" for its own panels for the same
  reason: one copy is the owner, every other is a photograph.
- **WebRTC now (C).** §4.8. The wire is not what makes it feel streamed; the picture, the cursor and the chrome
  are. If a measured WAN case shows TCP head-of-line blocking hurting, the encoder and the frame tags are already
  the shape a WebRTC video track wants, and the WebSocket becomes the signalling channel it would need anyway.
- **KasmVNC / Xvnc (D).** The mature answer to "damage-driven, lossless-refresh, low idle CPU", and the honest
  fallback if §6's grab cost bites at 4K. Against it: a second server with its own auth and WebSocket, a fork's
  RFB extensions to speak from our client, a whole-desktop picture again (the crop and CDP chrome would still be
  needed), and an X server less common than Xvfb under the one browser that has to look like a laptop's.
- **New headless + per-tab CDP screencast (G).** The pack's Dockerfile records why headed exists at all (WAFs
  block the headless shell); `screencast.ts` records the `<select>` gap; and JPEG frames measured 10× the bytes of
  video for a tenth of the frame rate. The path stays for display-less sandboxes only.
- **Hiding Chromium's chrome instead of cropping** (`--app`, `--kiosk`, a negative `--window-position`). App
  windows keep a 35 px bar of their own (measured on the popup), kiosk changes popup and tab behaviour, and a
  negative offset is a hack that saves nothing a crop does not. Cropping costs nothing and depends on nothing.
