import { wtypeArgs, xdotoolChord } from "./keys.js";
import { has, run } from "./run.js";
import { isWayland } from "./screen.js";
import { DesktopError, type MouseButton, type Point, type ScrollDirection } from "./types.js";

// Linux input is two backends: xdotool on X11, where any client can synthesise input. Wayland blocks that, so
// ydotool writes to /dev/uinput (needs the input group or a daemon) and wtype covers text/keys without it via the
// virtual-keyboard protocol. A missing tool's error names it and how to install it.

// Shared with apps-linux, so a missing xdotool prints the same message on both paths.
export const XDOTOOL_INSTALL = "sudo apt install xdotool  (or your distro's package)";
const YDOTOOL_INSTALL = "sudo apt install ydotool, then add yourself to the input group: sudo usermod -aG input $USER (log out and back in)";
const WTYPE_INSTALL = "sudo apt install wtype";

const XDOTOOL_BUTTON: Record<MouseButton, string> = { left: "1", middle: "2", right: "3" };
// ydotool bitmask: 0x40 press, 0x80 release; 0xC0/0xC1/0xC2 = full click for left/right/middle.
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
        // xdotool's own repeat with a delay so it registers as one double-click, not two.
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
            // 0x40 presses without releasing, 0x80 releases: the two halves of a drag.
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
                // `--` marks the text as an argument, not a flag, even if it starts with a dash.
                await run("wtype", ["--", text], WTYPE_INSTALL);
                return;
            }
            await ydotool(["type", "--", text]);
            return;
        }
        // Per-key delay: xdotool's default fires faster than some toolkits accept, dropping characters.
        await xdotool(["type", "--delay", "12", "--", text]);
    },

    key: async (combo: string): Promise<void> => {
        if (wayland()) {
            if (await has("wtype")) {
                await run("wtype", wtypeArgs(combo), WTYPE_INSTALL);
                return;
            }
            // ydotool's `key` wants keycodes, not names, so this reports the gap rather than mistranslating it.
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
        // X11 has no scroll axis: the wheel is buttons 4/5 (vertical) and 6/7 (horizontal).
        const button = { up: "4", down: "5", left: "6", right: "7" }[direction];
        await xdotool(["mousemove", String(Math.round(at.x)), String(Math.round(at.y)), "click", "--repeat", String(clicks), button]);
    },
};
