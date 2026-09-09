# @intentic/desktop-automation

Drive a desktop from Node, on Windows and Linux, with **no native modules**.

Capture the screen, move the pointer, click, type, press chords, scroll and drag.

```ts
import { desktop } from "@intentic/desktop-automation";

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
one consumer today is `@intentic/machine`, which owns that question: and the split is what makes the policy
testable, since a real click can only be verified by a human watching a screen.

## How it works, per platform

**Windows**: PowerShell into `user32.dll`. `SetCursorPos` + `mouse_event` for the pointer, `keybd_event` for
chords, and `SendKeys` for text only. The split is deliberate: SendKeys is the only one that handles arbitrary
unicode sensibly, and the only one that *cannot press the Windows key*: so text uses it and chords do not.
Screen capture is `System.Drawing`. No install step, nothing left resident.

**Linux**: two backends behind one interface. X11 lets any client synthesise input, so `xdotool` does
everything with no privileges. Wayland does not, so the pointer goes through `ydotool` (which needs
`/dev/uinput`) and text/keys prefer `wtype` (which does not). Missing tools raise a `DesktopError` carrying the
one-line install for the specific thing that is absent.

**macOS**: capture works, input does not. The methods throw rather than silently doing nothing.

**Windows enumeration**: `EnumWindows` supplies every visible top-level window, including several owned by one
process; process lookup adds the app name, and the remaining P/Invokes supply bounds and foreground state.
`Get-Process.MainWindowHandle` is intentionally not used because it collapses a workspace and its dialog into
one row.

**Taking focus on Windows needs more than `SetForegroundWindow`.** Windows refuses that call from a process
that is not already in the foreground, and refuses it *quietly*: it flashes the taskbar button and leaves the
keyboard where it was, so the next `type` or `key` goes to whatever the person at that desk had open. A backend
running from a fresh `powershell.exe` misses every qualifying condition at once, so `focusWindow` asks for
three of them together:

- it attaches its input queue to the foreground window's thread and the target's, which is what earns the right;
- it zeroes the **foreground-lock timeout** for the duration of the call and puts it back after. While that
  timeout is armed the refusal is unconditional, and no amount of queue attachment outvotes it. It is armed by
  ordinary desktop activity, and raised outright by gaming and anti-focus-stealing utilities;
- it synthesises a lone ALT *key-up*, which makes this process the one that received the last input event —
  another of the documented conditions. A key-up with no key-down before it is the half of the pair that no
  window reads as a press, so nothing on the desktop sees an ALT.

Then it *checks*, over three rounds, because the refusal is not always permanent: a window still mapping, or an
app that activates itself a moment after being asked to, loses the first round and wins the second. If the
keyboard still went elsewhere it raises a `DesktopError` **naming the window that kept it**, rather than
returning to a caller that is about to type into the wrong one.

**A refused focus states its cause, and `windowsSession()` is where it comes from.** The foreground can be held
by a window `windows()` does not return — a cloaked one, or the lock screen's, which has no row anywhere — so
looking for the holder in the window list answers "nobody" in exactly the case that matters. That read is the
OS's: `GetForegroundWindow` for the holder, and the presence of `LogonUI` for whether Windows is drawing its
sign-in screen over the desktop at all, which is a state in which nothing can be focused and nothing typed
lands. The message used to list every cause it might have been ("a UAC prompt, a full-screen app, or a locked
session") on every refusal; it now says which one the machine reported, and only admits to guessing when the
read itself failed. Windows-only, and named so: no compositor on Linux answers the second half.

**Wayland enumeration mostly cannot happen**, and that is a design decision rather than a gap: a compositor does
not let one client enumerate another's windows, the same protection that stops it synthesising input. The
wlroots family (sway, Hyprland) answers `swaymsg -t get_tree` to anyone who can reach the socket, so those are
supported; everything else gets a sentence explaining why, rather than an empty list that reads as "nothing is
open".

## Two details worth knowing

**Coordinates are screenshot pixels.** `frame()` also reports the virtual desktop's `origin`, which is not
always (0,0): a second monitor to the left of the primary one gives Windows a negative left edge. The backends
add it back, so callers work in screenshot pixels throughout and multi-monitor setups stop being a source of
silent misclicks.

**One key vocabulary, three renderings.** `keys.ts` fixes the names (X11 keysyms: `Return`, `Escape`,
`BackSpace`, `Page_Up`, plus `ctrl`/`alt`/`shift`/`super` and the aliases people actually type: `enter`, `esc`,
`win`, `cmd`) and each backend translates. Without it every caller would be platform-aware, which is the exact
coupling this package exists to remove.

## Key files

- [src/index.ts](src/index.ts): the public surface.
- [src/input-linux.ts](src/input-linux.ts) / [src/input-windows.ts](src/input-windows.ts): pointer, keys and text, per platform.
- [src/apps-linux.ts](src/apps-linux.ts) / [src/apps-windows.ts](src/apps-windows.ts): windows, focus, launching and the clipboard, per platform — and on Windows, whether the desktop can be driven at all.
- [src/screen.ts](src/screen.ts): capturing the screen.
- [src/keys.ts](src/keys.ts): chord and key-name parsing, shared by both platforms.
- [src/run.ts](src/run.ts): how commands are invoked without a native module.
