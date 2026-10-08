import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import { exec } from "@intentic/base/git";
import { type Desktop, DesktopError, desktop } from "@intentic/desktop-automation";
import type { DesktopState, DesktopWindow } from "@intentic/sandbox-contract";
import { adoptDisplay, type Display, displayOf, ensureDisplay } from "../browser/cast/display.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";

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
    // with "another window manager is already running", which is the outcome wanted. In a process group of its own, as
    // its display is, so a crashed daemon's group going with it leaves the desktop whole.
    const child = spawn("openbox", [], { env: { ...process.env, DISPLAY: display.name }, stdio: "ignore", detached: true });
    // Not installed until the sandbox is rebuilt with the browser pack: the desktop still works, undecorated.
    child.on("error", () => managers.delete(display.name));
    child.unref();
    managers.set(display.name, child);
};

/* What is on the desktop: which windows, off the window manager's client list (_NET_CLIENT_LIST on the root, the list
   wmctrl reads), and which of them has the keyboard (_NET_ACTIVE_WINDOW). Watched rather than polled: `xprop -spy`
   prints both once when it starts and again each time either changes, so the rail tile and the view hear of a window as
   it opens, closes or takes the focus, and an idle desktop costs one sleeping process. It is what tells an empty desktop,
   which is all black, from a picture that never arrived. */

// The ids one line of the spy names ("…: window id # 0x400024, 0x400031"), as numbers, none on an empty desktop. Numbers
// because the spy spells an id 0x400024 and wmctrl 0x00400024. Undefined for anything else, "not found" included: a
// display with no window manager on it has no list to read.
export const clientIds = (line: string): readonly number[] | undefined => {
    const list = /^_NET_CLIENT_LIST\(WINDOW\): window id #(.*)$/.exec(line.trim());
    return list === null ? undefined : (list[1]?.match(/0x[0-9a-f]+/gi) ?? []).map(Number);
};

export const clientCount = (line: string): number | undefined => clientIds(line)?.length;

// The window with the keyboard, off the same spy; 0 when none has it, undefined for a line about something else.
export const activeWindow = (line: string): number | undefined => {
    const active = /^_NET_ACTIVE_WINDOW\(WINDOW\): window id # (0x[0-9a-f]+)/i.exec(line.trim());
    return active?.[1] === undefined ? undefined : Number(active[1]);
};

const XPROP = "/usr/bin/xprop";

let clients: readonly number[] | undefined;
let active: number | undefined;
let watcher: ChildProcess | undefined;

const sameIds = (left: readonly number[] | undefined, right: readonly number[]): boolean =>
    left !== undefined && left.length === right.length && left.every((id, index) => id === right[index]);

const watchWindows = (display: Display): void => {
    if (watcher !== undefined || !existsSync(XPROP)) {
        return;
    }
    const child = spawn(XPROP, ["-root", "-spy", "_NET_CLIENT_LIST", "_NET_ACTIVE_WINDOW"], {
        env: { ...process.env, DISPLAY: display.name },
        stdio: ["ignore", "pipe", "ignore"],
    });
    watcher = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
        const ids = clientIds(line);
        if (ids !== undefined) {
            if (!sameIds(clients, ids)) {
                clients = ids;
                publishRuntimeChange("desktop");
            }
            return;
        }
        const focus = activeWindow(line);
        if (focus !== undefined && focus !== active) {
            active = focus;
            publishRuntimeChange("desktop");
        }
    });
    // Its display gone (or the spy itself), the list is nobody's: the next start of the desktop watches afresh.
    child.on("error", () => undefined);
    child.on("exit", () => {
        if (watcher === child) {
            watcher = undefined;
            clients = undefined;
            active = undefined;
            publishRuntimeChange("desktop");
        }
    });
    // A watcher never keeps the daemon, or a test that started the desktop, alive.
    child.unref();
    if (child.stdout instanceof Socket) {
        child.stdout.unref();
    }
};

// Whether the window manager still lists this window: undefined while there is no list to ask (the spy has not spoken
// yet, or there is no window manager), which is not the same as gone.
export const windowListed = (id: string): boolean | undefined => (clients === undefined ? undefined : clients.includes(Number(id)));

const screenOn = (display: Display): Desktop => desktop({ env: { ...process.env, DISPLAY: display.name } });

// Each window as the contract names it, read the way the agent's list_windows reads it. Undefined where there is no
// window manager to ask, or no wmctrl to ask it with.
const readList = async (display: Display): Promise<DesktopWindow[] | undefined> => {
    try {
        const windows = await screenOn(display).windows();
        return windows.map(({ id, app, title, focused }) => ({ id, app, title, focused }));
    } catch {
        // allow(silent-catch): a desktop with no window manager, or no wmctrl, has no list to give; `list` is then absent.
        return undefined;
    }
};

/* A title changes on the window, not on the root, so the spy never hears of it. While somebody has the view open the
   list is read again every few seconds instead, and a change is pushed like any other; with nobody looking nothing
   polls, and the next look reads it fresh anyway. */

const RELIST_MS = 2_500;

// The list as last answered or pushed, as one string, so a read that finds the same list says nothing.
let told: string | undefined;
let viewers = 0;
let relister: ReturnType<typeof setInterval> | undefined;

const relist = async (): Promise<void> => {
    const display = displayOf(DESKTOP_KEY);
    if (display === undefined) {
        return;
    }
    const list = await readList(display);
    const said = list === undefined ? undefined : JSON.stringify(list);
    if (said !== undefined && said !== told) {
        told = said;
        publishRuntimeChange("desktop");
    }
};

// One open desktop view, for as long as the returned release is not called.
export const desktopWatched = (): (() => void) => {
    viewers += 1;
    if (relister === undefined) {
        relister = setInterval(() => void relist(), RELIST_MS);
        relister.unref();
    }
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        viewers -= 1;
        if (viewers === 0) {
            clearInterval(relister);
            relister = undefined;
        }
    };
};

// Where one window is on the screen right now, off `xwininfo -id` ("Absolute upper-left X:  51", "Width: 300"): its
// inside, without the frame the window manager draws, the same rectangle list_windows reports. Undefined for output
// that does not say.
export const windowPlace = (output: string): { x: number; y: number; width: number; height: number } | undefined => {
    const field = (name: string): number | undefined => {
        const found = new RegExp(`^\\s*${name}:\\s*(-?\\d+)\\s*$`, "m").exec(output);
        return found?.[1] === undefined ? undefined : Number(found[1]);
    };
    const x = field("Absolute upper-left X");
    const y = field("Absolute upper-left Y");
    const width = field("Width");
    const height = field("Height");
    return x === undefined || y === undefined || width === undefined || height === undefined ? undefined : { x, y, width, height };
};

const XWININFO = "/usr/bin/xwininfo";
// A display that stopped answering must not hold the view's next look forever.
const PLACE_TIMEOUT_MS = 3_000;

// One window's place, or "gone" once X itself says there is no such window. Undefined when the read failed for any
// other reason (no xwininfo, a slow display): the caller keeps what it had and asks again.
export const readWindowPlace = async (display: Display, id: string): Promise<ReturnType<typeof windowPlace> | "gone"> => {
    try {
        const { stdout } = await exec(XWININFO, ["-id", id], { env: { ...process.env, DISPLAY: display.name }, timeout: PLACE_TIMEOUT_MS });
        return windowPlace(stdout);
    } catch (error) {
        const said = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        // allow(silent-catch): any failure but "no such window" is a read to retry, said by the undefined answer.
        return /No such window|BadWindow|Bad Drawable/i.test(said) ? "gone" : undefined;
    }
};

export interface AgentDesktop {
    readonly display: Display;
    readonly screen: Desktop;
}

// The desktop, started on first use: a turn that never calls a desktop tool never pays for a display.
export const agentDesktop = async (): Promise<AgentDesktop> => {
    const before = displayOf(DESKTOP_KEY);
    const display = await ensureDisplay(DESKTOP_KEY, DESKTOP_SIZE);
    startWindowManager(display);
    watchWindows(display);
    if (before?.name !== display.name) {
        publishRuntimeChange("desktop");
    }
    return { display, screen: screenOn(display) };
};

// Asked once per daemon life: after that a desktop this process does not know of is one nobody has started.
let adoptionAsked = false;

// Whether the desktop is up and what is on it (system.desktop). Never starts one, since a look at the rail is not a use
// of it; a desktop a previous daemon life left running is adopted on the first ask, its windows still there to be seen.
export const desktopState = async (): Promise<DesktopState> => {
    let display = displayOf(DESKTOP_KEY);
    if (display === undefined && !adoptionAsked) {
        adoptionAsked = true;
        display = await adoptDisplay(DESKTOP_KEY);
    }
    if (display === undefined) {
        return { running: false };
    }
    watchWindows(display);
    const state: DesktopState = { running: true, display: display.name };
    if (clients !== undefined) {
        state.windows = clients.length;
    }
    const list = await readList(display);
    if (list !== undefined) {
        state.list = list;
        // The spy may not have spoken yet on a desktop just started or adopted; the list has, and counts the same windows.
        state.windows ??= list.length;
        told = JSON.stringify(list);
    }
    return state;
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
