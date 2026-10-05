import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { type Desktop, DesktopError, desktop } from "@intentic/desktop-automation";
import { type Display, displayOf, ensureDisplay } from "../browser/cast/display.js";

/* The sandbox's own desktop: one virtual X display beside the browsers' (display.ts), with a window manager on it, that
   an agent drives through the `desktop` tools and the owner can watch and take over. For whatever has a window and no
   other way in: an app the agent is building, a GUI installer, a native tool's settings. One per sandbox, shared by
   every conversation, since a desktop is a place rather than a session. */

export const DESKTOP_KEY = "desktop";

// WXGA, the size computer-use models are trained around: a screenshot of it is read whole, with nothing shrunk, so
// every coordinate the agent reads off it is a real pixel.
export const DESKTOP_SIZE = { width: 1280, height: 800 } as const;

// What the desktop needs that the browser pack brings (Xvfb, ffmpeg for its picture, xdotool for its hands), and what
// it adds for windows (openbox to manage them, wmctrl and xwininfo to list them, xclip for the clipboard). The first
// three decide whether the tools are offered at all; the rest degrade one tool each, with a sentence saying so.
const REQUIRED = ["/usr/bin/Xvfb", "/usr/bin/ffmpeg", "/usr/bin/xdotool"] as const;

export const desktopAvailable = (): boolean => REQUIRED.every((path) => existsSync(path));

// The window manager, per display it was started on. Without one, windows open undecorated at (0,0), focus follows
// nothing and wmctrl has nothing to ask: it is what makes the display a desktop.
const managers = new Map<string, ChildProcess>();

const startWindowManager = (display: Display): void => {
    const running = managers.get(display.name);
    if (running !== undefined && running.exitCode === null && running.signalCode === null) {
        return;
    }
    // A manager left from a previous daemon life (the display is adopted across restarts) makes this one exit at once
    // with "another window manager is already running", which is the outcome wanted.
    const child = spawn("openbox", [], { env: { ...process.env, DISPLAY: display.name }, stdio: "ignore" });
    // Not installed until the sandbox is rebuilt with the browser pack: the desktop still works, undecorated.
    child.on("error", () => managers.delete(display.name));
    child.unref();
    managers.set(display.name, child);
};

export interface AgentDesktop {
    readonly display: Display;
    readonly screen: Desktop;
}

// The desktop, started on first use: a turn that never calls a desktop tool never pays for a display.
export const agentDesktop = async (): Promise<AgentDesktop> => {
    const display = await ensureDisplay(DESKTOP_KEY, DESKTOP_SIZE);
    startWindowManager(display);
    return { display, screen: desktop({ env: { ...process.env, DISPLAY: display.name } }) };
};

// The desktop only if it is already up: what the owner's view asks, since watching should not start one.
export const runningDesktop = (): AgentDesktop | undefined => {
    const display = displayOf(DESKTOP_KEY);
    return display === undefined ? undefined : { display, screen: desktop({ env: { ...process.env, DISPLAY: display.name } }) };
};

/* Who holds the desktop. The owner takes it by driving it from their view, and holds it until they hand it back or
   stop for a while; while they hold it every agent action is refused, so the agent never clicks into what a person
   is in the middle of. Looking is never refused: a screenshot changes nothing. */

// How long a hold lasts past the owner's last input when the view did not say it handed back: long enough for a
// person reading what they just did, short enough that a closed tab does not lock the agent out for good.
export const OWNER_IDLE_MS = 20_000;

let ownerUntil = 0;

export const ownerDriving = (forMs: number = OWNER_IDLE_MS, now: number = Date.now()): void => {
    ownerUntil = Math.max(ownerUntil, now + forMs);
};

export const ownerHandedBack = (): void => {
    ownerUntil = 0;
};

export const ownerHolds = (now: number = Date.now()): boolean => now < ownerUntil;

export class DesktopHeldError extends DesktopError {}

export const assertAgentMayDrive = (now: number = Date.now()): void => {
    if (ownerHolds(now)) {
        throw new DesktopHeldError(
            `Refused: the owner is using this desktop right now, from their view in the editor. Wait for them to hand it back ` +
                `(about ${Math.ceil((ownerUntil - now) / 1_000)}s after their last input, or sooner if they press Hand back), then take a fresh screenshot: ` +
                `the screen will have changed under you.`,
        );
    }
};
