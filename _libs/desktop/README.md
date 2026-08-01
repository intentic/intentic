# @intentic/desktop

Drive a desktop from Node: capture the screen, move the pointer, click, type, press chords, scroll and drag —
on Windows and Linux, with **no native modules**.

```ts
import { desktop } from "@intentic/desktop";

const screen = desktop();
const { width, height } = await screen.frame();
const png = await screen.capture();
await screen.click({ x: 840, y: 512 }, "left");
await screen.type("hello world");
await screen.key("ctrl+s");

// …and operating applications, not just pixels
await screen.launch("https://example.com");
const open = await screen.windows();          // app, title, bounds, focused
await screen.focusWindow(open[0]!.id);        // typing goes to the FOCUSED window
await screen.writeClipboard("some text");
```

## What this package is not

It knows nothing about agents, capabilities, permissions or sandboxes. It takes coordinates and text and makes a
computer do something; *whether that is allowed* is a question asked before these methods are ever called. Its
one consumer today is `@intentic/host`, which owns that question — and the split is what makes the policy
testable, since a real click can only be verified by a human watching a screen.

## How it works, per platform

**Windows** — PowerShell into `user32.dll`. `SetCursorPos` + `mouse_event` for the pointer, `keybd_event` for
chords, and `SendKeys` for text only. The split is deliberate: SendKeys is the only one that handles arbitrary
unicode sensibly, and the only one that *cannot press the Windows key* — so text uses it and chords do not.
Screen capture is `System.Drawing`. No install step, nothing left resident.

**Linux** — two backends behind one interface. X11 lets any client synthesise input, so `xdotool` does
everything with no privileges. Wayland does not, so the pointer goes through `ydotool` (which needs
`/dev/uinput`) and text/keys prefer `wtype` (which does not). Missing tools raise a `DesktopError` carrying the
one-line install for the specific thing that is absent.

**macOS** — capture works, input does not. The methods throw rather than silently doing nothing.

**Windows enumeration** — `Get-Process` already knows every process with a main window and its title; the
P/Invoke is only for the two things it does not carry, the window rectangle and which window is in front.

**Wayland enumeration mostly cannot happen**, and that is a design decision rather than a gap: a compositor does
not let one client enumerate another's windows, the same protection that stops it synthesising input. The
wlroots family (sway, Hyprland) answers `swaymsg -t get_tree` to anyone who can reach the socket, so those are
supported; everything else gets a sentence explaining why, rather than an empty list that reads as "nothing is
open".

## Two details worth knowing

**Coordinates are screenshot pixels.** `frame()` also reports the virtual desktop's `origin`, which is not
always (0,0) — a second monitor to the left of the primary one gives Windows a negative left edge. The backends
add it back, so callers work in screenshot pixels throughout and multi-monitor setups stop being a source of
silent misclicks.

**One key vocabulary, three renderings.** `keys.ts` fixes the names (X11 keysyms: `Return`, `Escape`,
`BackSpace`, `Page_Up`, plus `ctrl`/`alt`/`shift`/`super` and the aliases people actually type — `enter`, `esc`,
`win`, `cmd`) and each backend translates. Without it every caller would be platform-aware, which is the exact
coupling this package exists to remove.
