import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { looksLikeUrl, parseSwayTree, parseWmctrl } from "./parse.js";
import { has, run } from "./run.js";
import { isWayland } from "./screen.js";
import { DesktopError, type WindowInfo } from "./types.js";

/* Linux: what is open, and how to open more of it.
 *
 * X11 answers all of this through `wmctrl` and `xdotool`, which every desktop has or can install in one line.
 *
 * WAYLAND MOSTLY CANNOT, and that is a design decision rather than a gap: a compositor does not let one client
 * enumerate another's windows, which is the same protection that stops it synthesising input. The exception is
 * the wlroots family (sway, Hyprland) whose i3-style IPC will answer `get_tree` to anyone who can reach the
 * socket. So sway is supported and everything else gets a sentence explaining why, rather than an empty list
 * that reads as "nothing is open". */

const WMCTRL_INSTALL = "sudo apt install wmctrl  (or your distro's package)";
const XDOTOOL_INSTALL = "sudo apt install xdotool  (or your distro's package)";
const CLIP_INSTALL_X11 = "sudo apt install xclip";
const CLIP_INSTALL_WAYLAND = "sudo apt install wl-clipboard";

const swayRunning = (): boolean => process.env["SWAYSOCK"] !== undefined || process.env["I3SOCK"] !== undefined;

export const linuxApps = {
    windows: async (): Promise<WindowInfo[]> => {
        if (isWayland()) {
            if (swayRunning() && (await has("swaymsg"))) {
                return parseSwayTree(await run("swaymsg", ["-t", "get_tree"]));
            }
            throw new DesktopError(
                "This Wayland session does not let a program list other windows: the compositor refuses it by design, and only sway/Hyprland offer an IPC that answers. Use a screenshot to see what is open, or log in to an X11 session for full window control.",
            );
        }
        // The active window first, so `focused` can be filled in: wmctrl does not report it.
        const active = await run("xdotool", ["getactivewindow"], XDOTOOL_INSTALL).catch(() => "");
        const listed = await run("wmctrl", ["-lGpx"], WMCTRL_INSTALL);
        return parseWmctrl(listed, active.trim() === "" ? undefined : active.trim());
    },

    focusWindow: async (id: string): Promise<void> => {
        if (isWayland()) {
            if (swayRunning() && (await has("swaymsg"))) {
                await run("swaymsg", [`[con_id=${id}]`, "focus"]);
                return;
            }
            throw new DesktopError(
                "This Wayland session does not let a program focus another window. Click it with the pointer instead, or use an X11 session.",
            );
        }
        // windowactivate rather than windowfocus: it also raises the window and switches desktop if needed,
        // which is what a person means by "bring it up".
        await run("xdotool", ["windowactivate", "--sync", id], XDOTOOL_INSTALL);
    },

    /* Two different things wear one verb. A URL or an existing file goes to the desktop's handler (`xdg-open`);
     * anything else is a program to start. Getting that backwards is the difference between the user's browser
     * opening and a "command not found", so it is decided by looking rather than by guessing.
     *
     * Detached and with its streams discarded: this agent should not become the parent that a text editor's
     * lifetime depends on, and a launched app writing to a pipe nobody reads eventually blocks. */
    launch: async (target: string): Promise<void> => {
        const viaOpener = looksLikeUrl(target) || existsSync(target);
        if (viaOpener && !(await has("xdg-open"))) {
            throw new DesktopError(`This computer has no "xdg-open" to open "${target}" with.`, "sudo apt install xdg-utils");
        }
        const [command, args] = viaOpener
            ? (["xdg-open", [target]] as const)
            : ([target.split(/\s+/)[0] ?? target, target.split(/\s+/).slice(1)] as const);
        const child = spawn(command, [...args], { detached: true, stdio: "ignore" });
        child.unref();
        // An immediate spawn error (no such program) arrives asynchronously, so give it the tick it needs to be
        // reported as a refusal rather than as silence.
        await new Promise<void>((resolvePromise, reject) => {
            child.once("error", (error) => reject(new DesktopError(`Could not start "${target}": ${error.message}`)));
            setTimeout(resolvePromise, 50);
        });
    },

    readClipboard: async (): Promise<string> =>
        isWayland()
            ? await run("wl-paste", ["--no-newline"], CLIP_INSTALL_WAYLAND)
            : await run("xclip", ["-selection", "clipboard", "-o"], CLIP_INSTALL_X11),

    writeClipboard: async (text: string): Promise<void> => {
        const [command, args, install] = isWayland()
            ? (["wl-copy", [], CLIP_INSTALL_WAYLAND] as const)
            : (["xclip", ["-selection", "clipboard"], CLIP_INSTALL_X11] as const);
        await new Promise<void>((resolvePromise, reject) => {
            const child = spawn(command, [...args], { stdio: ["pipe", "ignore", "ignore"] });
            child.once("error", (error) => reject(new DesktopError(`Could not set the clipboard with "${command}": ${error.message}`, install)));
            child.once("close", () => resolvePromise());
            child.stdin.end(text);
        });
    },
};
