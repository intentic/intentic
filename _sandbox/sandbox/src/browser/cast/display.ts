import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { pollUntil } from "@intentic/base/async";

// A virtual X display per browser, not shared, since the picture now comes from the display itself (videocast.ts,
// xinput.ts): sharing would overlap windows and share one cursor across browsers. Cheap (Xvfb, ~15 MB), bounded by
// connected accounts; ships with the browser capability, so an unconnected sandbox has none.

// Screen and window Chromium fills exactly; input uses display coordinates, ignoring chrome height.
export const DISPLAY_WIDTH = 1280;
export const DISPLAY_HEIGHT = 880;

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
const lockPath = (number: number): string => `/tmp/.X${number}-lock`;

// A claim file beside the X socket names which key owns it, so a restarted daemon adopts its own display (browsers and
// all) instead of leaking one per restart; an exit handler can't cover a SIGKILL or a container stop.
const claimPath = (number: number): string => `/tmp/.intentic-display-${number}`;

const claimedBy = (number: number): string | undefined => {
    try {
        return readFileSync(claimPath(number), "utf8").trim() || undefined;
    } catch {
        return undefined;
    }
};

// Liveness is probed, not inferred from the socket file: /tmp can survive a restart with a dead server's socket still
// on disk, which once made every browser tool fail until a human deleted the stale files.
const answers = (number: number): Promise<boolean> =>
    new Promise((resolve) => {
        const socket = connect(socketPath(number));
        const settle = (answer: boolean): void => {
            socket.destroy();
            resolve(answer);
        };
        socket.once("connect", () => settle(true));
        socket.once("error", () => settle(false));
        // A socket that neither connects nor refuses is not a display anything should be launched against.
        socket.setTimeout(500, () => settle(false));
    });

const waitForDisplay = async (number: number): Promise<void> => {
    if (!(await pollUntil(() => answers(number), { intervalMs: 50, timeoutMs: 5_000 }))) {
        throw new Error(`Xvfb did not come up on :${number} (nothing answering on ${socketPath(number)}): rebuild the sandbox to install it`);
    }
};

const displayAt = (number: number): Display => ({ name: `:${number}`, width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT });

// Two passes: a live server this key already claimed (the restart case, cheaper to adopt), else the lowest number
// nothing answers on. Probed rather than counted, since a server can outlive the process that started it.
const placeFor = async (key: string): Promise<{ readonly number: number; readonly adopt: boolean }> => {
    const held = new Set([...running.values()].map((server) => Number(server.display.name.slice(1))));
    const free: number[] = [];
    for (let number = FIRST; number <= LAST; number++) {
        if (held.has(number)) {
            continue;
        }
        if (await answers(number)) {
            if (claimedBy(number) === key) {
                return { number, adopt: true };
            }
            continue;
        }
        free.push(number);
    }
    const number = free[0];
    if (number === undefined) {
        throw new Error(`no free X display between :${FIRST} and :${LAST}`);
    }
    return { number, adopt: false };
};

const start = async (key: string): Promise<Display> => {
    const { number, adopt } = await placeFor(key);
    if (adopt) {
        // A previous life started this, still serving this key's browsers; nothing to spawn, and not ours to kill.
        const display = displayAt(number);
        running.set(key, { display, child: undefined });
        return display;
    }
    // Socket/lock of a server not actually there; Xvfb treats either as taken, so remove them only here.
    rmSync(socketPath(number), { force: true });
    rmSync(lockPath(number), { force: true });
    // Written before the spawn, so a claimed server is claimed from its first breath.
    writeFileSync(claimPath(number), key, { mode: 0o600 });
    // -nolisten tcp: local socket only. -ac: no X access control (single-tenant sandbox).
    const child = spawn("Xvfb", [`:${number}`, "-screen", "0", `${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}x24`, "-nolisten", "tcp", "-ac"], {
        stdio: "ignore",
    });
    // Swallow ENOENT (Xvfb not installed until the owner rebuilds); it surfaces via the display-wait timeout.
    child.on("error", () => {});
    // Unref'd so an idle display never keeps the daemon alive.
    child.unref();
    await waitForDisplay(number);
    const display = displayAt(number);
    running.set(key, { display, child });
    return display;
};

// Ensures a display answers for `key`, idempotent and concurrency-safe: concurrent callers share one spawn, nothing
// dead stays remembered as up. Same key always lands on the same display, login window and later tools alike.
export const ensureDisplay = async (key: string): Promise<Display> => {
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
    const attempt = allocating.then(() => start(key)).finally(() => starting.delete(key));
    starting.set(key, attempt);
    // Chain must not break on failure: a display that won't start is this caller's problem, not the next one's.
    allocating = attempt.catch(() => undefined);
    return attempt;
};

// The display a key already has, without starting one; what the view route asks, since it's looking at a browser
// someone else launched.
export const displayOf = (key: string): Display | undefined => running.get(key)?.display;

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
