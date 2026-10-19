import type { ChipPlace } from "./chip.js";

// The focus watcher on Linux: AT-SPI, the desktop's accessibility bus, through python3's GObject bindings (python3-gi
// with the Atspi typelib, on by default in GNOME and KDE). It listens for `object:state-changed:focused` and prints one
// JSON line per focus: whether the role is a password field, the focused process's executable (/proc/<pid>/exe, the same
// user's), and the field's extents on screen. Where python3 or its Atspi bindings are missing the watcher stops at once
// and the chip stays off (`app sources` says apps are unavailable, and why). The field's text is never read.
//
// A Wayland compositor does not let a program place a window at screen coordinates, so the chip on Linux is a desktop
// notification with one action (notify-send --action, libnotify 0.7.9 and later): it does not take focus either, and
// clicking its action prints the action's name, which the helper reads as the click.

const LINUX_WATCH_SCRIPT = String.raw`
import json, os, sys
try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except Exception as error:
    sys.stderr.write("no AT-SPI bindings: %s\n" % error)
    sys.exit(3)

def path_of(pid):
    try:
        return os.readlink("/proc/%d/exe" % pid)
    except OSError:
        return ""

def focused(event):
    if event.detail1 != 1:
        return
    try:
        source = event.source
        role = source.get_role()
        pid = source.get_process_id()
        if pid == os.getpid():
            return
        try:
            box = source.get_extents(Atspi.CoordType.SCREEN)
            x, y, width, height = box.x, box.y, box.width, box.height
        except Exception:
            x, y, width, height = 0, 0, 0, 0
        line = {"event": "focus", "password": role == Atspi.Role.PASSWORD_TEXT, "path": path_of(pid), "x": x, "y": y, "width": width, "height": height}
        sys.stdout.write("intentic-keyring>" + json.dumps(line) + "\n")
        sys.stdout.flush()
    except Exception:
        pass

listener = Atspi.EventListener.new(focused)
listener.register("object:state-changed:focused")
Atspi.event_main()
`;

export const linuxWatchArgs = (): readonly string[] => ["-c", LINUX_WATCH_SCRIPT];
export const LINUX_WATCH_COMMAND = "python3";

// The chip's action name, which notify-send prints when it is clicked.
export const LINUX_CHIP_ACTION = "fill";

/** notify-send's argv for one chip. Where it shows is the notification server's to choose; `_at` is not used. Pure. */
export const linuxChipArgs = (label: string, _at: ChipPlace): readonly string[] => [
    "--app-name=Passwords",
    "--expire-time=8000",
    "--urgency=low",
    `--action=${LINUX_CHIP_ACTION}=${label}`,
    "Passwords",
    `${label} for the password field you are in.`,
];
