import { wtypeArgs, xdotoolChord } from "./keys.js";
import { has, run } from "./run.js";
import { isWayland } from "./screen.js";
import { DesktopError, type MouseButton, type Point, type ScrollDirection } from "./types.js";

/* Linux input, which is really two backends wearing one coat.
 *
 * X11 lets any client synthesise input, so `xdotool` does everything and needs no privileges. Wayland
 * deliberately does not — a compositor will not let one client type into another — so the only general way
 * through is the kernel: `ydotool` writes to /dev/uinput, which needs a group or a daemon. `wtype` is the
 * exception that works without it for TEXT and KEYS via the virtual-keyboard protocol, so it is preferred where
 * it applies and ydotool carries the pointer.
 *
 * When the tool is missing the message says which one and how to get it, because on Wayland "it didn't work" is
 * almost always one package or one `usermod -aG input` away, and that is a sentence the user can act on rather
 * than a capability they conclude is broken. */

const XDOTOOL_INSTALL = "sudo apt install xdotool  (or your distro's package)";
const YDOTOOL_INSTALL = "sudo apt install ydotool, then add yourself to the input group: sudo usermod -aG input $USER (log out and back in)";
const WTYPE_INSTALL = "sudo apt install wtype";

const XDOTOOL_BUTTON: Record<MouseButton, string> = { left: "1", middle: "2", right: "3" };
// ydotool speaks the kernel's button numbering with a down/up bitmask: 0x00 left, 0x01 right, 0x02 middle;
// 0x40 means press and 0x80 release, so 0xC0 is a full click.
const YDOTOOL_BUTTON: Record<MouseButton, string> = { left: "0xC0", right: "0xC1", middle: "0xC2" };

const wayland = (): boolean => isWayland();

const xdotool = (args: readonly string[]): Promise<string> => run("xdotool", args, XDOTOOL_INSTALL);
const ydotool = (args: readonly string[]): Promise<string> => run("ydotool", args, YDOTOOL_INSTALL);

export const linuxInput = {
    move: async (to: Point): Promise<void> => {
        if (wayland()) {
            await ydotool(["mousemove", "--absolute", "-x", String(Math.round(to.x)), "-y", String(Math.round(to.y))]);
            return;
        }
        await xdotool(["mousemove", String(Math.round(to.x)), String(Math.round(to.y))]);
    },

    click: async (at: Point, button: MouseButton): Promise<void> => {
        if (wayland()) {
            await linuxInput.move(at);
            await ydotool(["click", YDOTOOL_BUTTON[button]]);
            return;
        }
        await xdotool(["mousemove", String(Math.round(at.x)), String(Math.round(at.y)), "click", XDOTOOL_BUTTON[button]]);
    },

    doubleClick: async (at: Point): Promise<void> => {
        if (wayland()) {
            await linuxInput.move(at);
            await ydotool(["click", YDOTOOL_BUTTON.left]);
            await ydotool(["click", YDOTOOL_BUTTON.left]);
            return;
        }
        // xdotool's own repeat, with the delay a double-click needs to register as one rather than as two clicks.
        await xdotool([
            "mousemove",
            String(Math.round(at.x)),
            String(Math.round(at.y)),
            "click",
            "--repeat",
            "2",
            "--delay",
            "40",
            XDOTOOL_BUTTON.left,
        ]);
    },

    drag: async (from: Point, to: Point): Promise<void> => {
        if (wayland()) {
            await linuxInput.move(from);
            // 0x40 = press without release, 0x80 = release — the two halves a drag needs around the move.
            await ydotool(["click", "0x40"]);
            await linuxInput.move(to);
            await ydotool(["click", "0x80"]);
            return;
        }
        await xdotool(["mousemove", String(Math.round(from.x)), String(Math.round(from.y)), "mousedown", "1"]);
        await xdotool(["mousemove", String(Math.round(to.x)), String(Math.round(to.y))]);
        await xdotool(["mouseup", "1"]);
    },

    type: async (text: string): Promise<void> => {
        if (wayland()) {
            if (await has("wtype")) {
                // `--` so text beginning with a dash is text, not a flag.
                await run("wtype", ["--", text], WTYPE_INSTALL);
                return;
            }
            await ydotool(["type", "--", text]);
            return;
        }
        // A small per-key delay: xdotool's default fires faster than some toolkits accept, dropping characters.
        await xdotool(["type", "--delay", "12", "--", text]);
    },

    key: async (combo: string): Promise<void> => {
        if (wayland()) {
            if (await has("wtype")) {
                await run("wtype", wtypeArgs(combo), WTYPE_INSTALL);
                return;
            }
            // ydotool's `key` wants keycodes rather than names, which is a different vocabulary than this package
            // promises — so rather than half-translate it, say what is missing.
            throw new DesktopError("Pressing key combinations on Wayland needs wtype.", WTYPE_INSTALL);
        }
        await xdotool(["key", "--clearmodifiers", xdotoolChord(combo)]);
    },

    scroll: async (at: Point, direction: ScrollDirection, amount: number): Promise<void> => {
        const clicks = Math.max(1, Math.round(amount));
        if (wayland()) {
            await linuxInput.move(at);
            const axis = direction === "up" || direction === "down" ? "--wheel" : "--hwheel";
            const sign = direction === "down" || direction === "right" ? 1 : -1;
            await ydotool(["mousemove", axis, String(sign * clicks)]);
            return;
        }
        // X11 has no scroll axis: the wheel IS buttons 4/5 (vertical) and 6/7 (horizontal).
        const button = { up: "4", down: "5", left: "6", right: "7" }[direction];
        await xdotool(["mousemove", String(Math.round(at.x)), String(Math.round(at.y)), "click", "--repeat", String(clicks), button]);
    },
};
