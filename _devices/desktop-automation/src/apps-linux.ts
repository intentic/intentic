import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { looksLikeUrl, parseSwayTree, parseWmctrl } from "./parse.js";
import { has, run } from "./run.js";
import { isWayland } from "./screen.js";
import { DesktopError, type WindowInfo } from "./types.js";
import { XDOTOOL_INSTALL } from "./input-linux.js";

// Linux window listing/control. X11 uses wmctrl/xdotool. Wayland mostly refuses by design (a compositor won't let
// one client enumerate another's windows); the wlroots family (sway, Hyprland) exposes an i3-style `get_tree` IPC
// instead, so only sway is supported and everything else gets an explanatory error rather than an empty list.

const WMCTRL_INSTALL = "sudo apt install wmctrl  (or your distro's package)";
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
        // windowactivate, not windowfocus: it also raises the window and switches desktop, matching "bring it up".
        await run("xdotool", ["windowactivate", "--sync", id], XDOTOOL_INSTALL);
    },

    // A URL or existing file goes to xdg-open; anything else is a program to start, decided by looking rather than
    // guessing. Detached with streams discarded, so this agent isn't the parent a launched app's lifetime depends on.
    launch: async (target: string): Promise<void> => {
        const viaOpener = looksLikeUrl(target) || existsSync(target);
        if (viaOpener && !(await has("xdg-open"))) {
            throw new DesktopError(`This device has no "xdg-open" to open "${target}" with.`, "sudo apt install xdg-utils");
        }
        const [command, args] = viaOpener
            ? (["xdg-open", [target]] as const)
            : ([target.split(/\s+/)[0] ?? target, target.split(/\s+/).slice(1)] as const);
        const child = spawn(command, [...args], { detached: true, stdio: "ignore" });
        child.unref();
        // Immediate spawn errors arrive asynchronously; wait one tick so they surface as a refusal, not silence.
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
