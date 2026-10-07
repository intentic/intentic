import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { pollUntil } from "@intentic/base/async";
import { spawnAs } from "../../workload/workload-class.js";

// A virtual X display per browser, not shared, since the picture now comes from the display itself (videocast.ts,
// xinput.ts): sharing would overlap windows and share one cursor across browsers. Cheap (Xvfb, ~16 MB), bounded by
// connected accounts; ships with the browser capability, so an unconnected sandbox has none.

// The screen, larger than any window: a window grows to the owner's own pane (region.ts) without the X server
// changing shape, which Xvfb cannot do.
export const DISPLAY_WIDTH = 2560;
export const DISPLAY_HEIGHT = 1600;
// A browser window's size before any viewer has asked for one.
export const WINDOW_WIDTH = 1280;
export const WINDOW_HEIGHT = 880;

// The launch flags for a window someone watches on this display. Placed in the screen's bottom-right corner, the corner
// region.ts keeps it in: Chromium flips a menu that would leave the screen, so a window whose right and bottom edges are
// the screen's keeps every <select> and context menu inside the viewport that is grabbed. And without the "Restore
// pages?" bubble a profile asks for after any unclean exit (a daemon restart is one): it is drawn over the page, so it
// is in the video but never in a still, and came and went as the picture switched between them.
export const chromiumWindowArgs = (display: Display): string[] => [
    `--window-position=${display.width - WINDOW_WIDTH},${display.height - WINDOW_HEIGHT}`,
    `--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`,
    `--hide-crash-restore-bubble`,
];

// Display numbers climb from FIRST (:99, unchanged from before); LAST only backstops a runaway.
const FIRST = 99;
const LAST = 160;

export interface Display {
    // The DISPLAY value, ":99". What Chromium is launched with and what x11grab and xdotool are pointed at.
    readonly name: string;
    readonly width: number;
    readonly height: number;
}

interface Server {
    readonly display: Display;
    // Held so the display dies with its browser; undefined when adopted, since adopting isn't owning.
    readonly child: ChildProcess | undefined;
}

const running = new Map<string, Server>();
// One spawn per key even with concurrent callers; dropped once settled, so a later death starts a fresh spawn.
const starting = new Map<string, Promise<Display>>();

// Allocation is serialized across keys: probe-then-spawn is two steps; racing keys could land on one number.
let allocating: Promise<unknown> = Promise.resolve();

const socketPath = (number: number): string => `/tmp/.X11-unix/X${number}`;
// The second socket an X server binds on Linux: abstract-namespace, unlinkable, released only when the process exits.
const abstractPath = (number: number): string => `\0${socketPath(number)}`;
const lockPath = (number: number): string => `/tmp/.X${number}-lock`;

const XVFB_BINARY = "/usr/bin/Xvfb";

// A claim file beside the X socket names which key owns it, so a restarted daemon adopts its own display (browsers and
// all) instead of leaking one per restart; an exit handler can't cover a SIGKILL or a container stop.
const claimPath = (number: number): string => `/tmp/.intentic-display-${number}`;

// The claim's first line is the key; its second the screen's size, for a display started at a size of its own (the
// agent desktop's), so the one adopted after a restart is described at the size it really has.
const claimLines = (number: number): string[] => {
    try {
        return readFileSync(claimPath(number), "utf8").split("\n").map((line) => line.trim());
    } catch {
        return [];
    }
};

const claimedBy = (number: number): string | undefined => claimLines(number)[0] || undefined;

export interface DisplaySize {
    readonly width: number;
    readonly height: number;
}

const BROWSER_SIZE: DisplaySize = { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT };

const claimedSize = (number: number): DisplaySize => {
    const [width, height] = (claimLines(number)[1] ?? "").split("x").map(Number);
    return width !== undefined && height !== undefined && width > 0 && height > 0 ? { width, height } : BROWSER_SIZE;
};

// "usable": a client can connect. "free": safe to claim. "held": neither — nothing to launch against, nothing to clobber.
type Presence = "usable" | "held" | "free";

// ENOENT (no file) and ECONNREFUSED (nothing bound) are the only answers that prove a socket is nobody's; every other
// outcome, silence included, leaves an owner possible.
const reach = (path: string): Promise<"connected" | "absent" | "busy"> =>
    new Promise((resolve) => {
        const socket = connect({ path });
        const settle = (answer: "connected" | "absent" | "busy"): void => {
            socket.destroy();
            resolve(answer);
        };
        socket.once("connect", () => settle("connected"));
        socket.once("error", (error: NodeJS.ErrnoException) =>
            settle(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "absent" : "busy"),
        );
        socket.setTimeout(500, () => settle("busy"));
    });

// Liveness is probed, not inferred from the socket file: /tmp can survive a restart with a dead server's socket still
// on disk, which once made every browser tool fail until a human deleted the stale files.
// Both sockets are probed, since a server whose file was unlinked still owns the number through the abstract one:
// claiming it unlinks nothing Xvfb will rebind, and the respawn dies on "server already running" forever after.
export const presenceOf = async (number: number): Promise<Presence> => {
    const [file, abstract] = await Promise.all([reach(socketPath(number)), reach(abstractPath(number))]);
    if (file === "connected" || abstract === "connected") {
        return "usable";
    }
    return file === "absent" && abstract === "absent" ? "free" : "held";
};

const answers = async (number: number): Promise<boolean> => (await presenceOf(number)) === "usable";

const waitForDisplay = async (number: number): Promise<void> => {
    if (await pollUntil(() => answers(number), { intervalMs: 50, timeoutMs: 5_000 })) {
        return;
    }
    // A missing Xvfb and an unusable display number wear one symptom; naming the wrong one sends owners to rebuild a
    // sandbox whose browser pack was never the problem.
    throw new Error(
        existsSync(XVFB_BINARY)
            ? `Xvfb did not come up on :${number} (nothing answering on ${socketPath(number)})`
            : `Xvfb is not installed (no ${XVFB_BINARY}): rebuild the sandbox to install the browser pack`,
    );
};

const displayAt = (number: number, size: DisplaySize): Display => ({ name: `:${number}`, ...size });

// Two passes: a live server this key already claimed (the restart case, cheaper to adopt), else the lowest number
// nothing answers on. Probed rather than counted, since a server can outlive the process that started it.
const placeFor = async (key: string): Promise<{ readonly number: number; readonly adopt: boolean }> => {
    const held = new Set([...running.values()].map((server) => Number(server.display.name.slice(1))));
    const free: number[] = [];
    for (let number = FIRST; number <= LAST; number++) {
        if (held.has(number)) {
            continue;
        }
        const presence = await presenceOf(number);
        if (presence === "usable" && claimedBy(number) === key) {
            return { number, adopt: true };
        }
        // Only a number proved to be nobody's is claimable; "held" is skipped rather than taken, since taking it
        // unlinks a live server's socket and leaves the display unreachable to everyone.
        if (presence === "free") {
            free.push(number);
        }
    }
    const number = free[0];
    if (number === undefined) {
        throw new Error(`no free X display between :${FIRST} and :${LAST}`);
    }
    return { number, adopt: false };
};

const start = async (key: string, size: DisplaySize): Promise<Display> => {
    const { number, adopt } = await placeFor(key);
    if (adopt) {
        // A previous life started this, still serving this key's browsers; nothing to spawn, and not ours to kill.
        const display = displayAt(number, claimedSize(number));
        running.set(key, { display, child: undefined });
        return display;
    }
    // Socket/lock of a server not actually there; Xvfb treats either as taken, so remove them only here.
    rmSync(socketPath(number), { force: true });
    rmSync(lockPath(number), { force: true });
    // Written before the spawn, so a claimed server is claimed from its first breath.
    writeFileSync(claimPath(number), `${key}\n${size.width}x${size.height}`, { mode: 0o600 });
    // -nolisten tcp: local socket only. -ac: no X access control (single-tenant sandbox). In a process group of its own,
    // since intentic-netd ends a crashed daemon's group with it, and this server is the next daemon's to adopt.
    const child = spawnAs({ class: "service" }, "Xvfb", [`:${number}`, "-screen", "0", `${size.width}x${size.height}x24`, "-nolisten", "tcp", "-ac"], {
        stdio: "ignore",
        detached: true,
    });
    // Swallow ENOENT (Xvfb not installed until the owner rebuilds); it surfaces via the display-wait timeout.
    child.on("error", () => {});
    // Unref'd so an idle display never keeps the daemon alive.
    child.unref();
    await waitForDisplay(number);
    const display = displayAt(number, size);
    running.set(key, { display, child });
    return display;
};

// Ensures a display answers for `key`, idempotent and concurrency-safe: concurrent callers share one spawn, nothing
// dead stays remembered as up. Same key always lands on the same display, login window and later tools alike. `size`
// applies when a server is started; one already running keeps the size it has.
export const ensureDisplay = async (key: string, size: DisplaySize = BROWSER_SIZE): Promise<Display> => {
    const existing = running.get(key);
    if (existing !== undefined && (await answers(Number(existing.display.name.slice(1))))) {
        return existing.display;
    }
    running.delete(key);
    const pending = starting.get(key);
    if (pending !== undefined) {
        return pending;
    }
    // Queued behind every other allocation: probe-and-claim is two steps; interleaving can collide on one number.
    const attempt = allocating.then(() => start(key, size)).finally(() => starting.delete(key));
    starting.set(key, attempt);
    // Chain must not break on failure: a display that won't start is this caller's problem, not the next one's.
    allocating = attempt.catch(() => undefined);
    return attempt;
};

// The display a key already has, without starting one; what the view route asks, since it's looking at a browser
// someone else launched.
export const displayOf = (key: string): Display | undefined => running.get(key)?.display;

// The display a previous daemon life started for `key` and left serving, adopted without starting one; undefined when
// there is none. For a reader that must not start a display but should see one that is already up: the agent desktop's
// state after a restart, before anything in this process has asked ensureDisplay for it.
export const adoptDisplay = async (key: string): Promise<Display | undefined> => {
    const known = displayOf(key);
    if (known !== undefined) {
        return known;
    }
    for (let number = FIRST; number <= LAST; number++) {
        if (claimedBy(number) === key && (await answers(number))) {
            return ensureDisplay(key, claimedSize(number));
        }
    }
    return undefined;
};

// Stops the display for `key` once its browser is gone. Best-effort, never awaited on a path that matters; an adopted
// display is only forgotten, since killing a server this process didn't start could take down whatever else is on it.
export const releaseDisplay = (key: string): void => {
    const server = running.get(key);
    running.delete(key);
    if (server?.child === undefined) {
        return;
    }
    try {
        server.child.kill();
        // Claim goes with the server; left behind it would misattribute a reused number, harmless but sloppy.
        rmSync(claimPath(Number(server.display.name.slice(1))), { force: true });
    } catch {
        // already gone, which is the outcome asked for
    }
};
