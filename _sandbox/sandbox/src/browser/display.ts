import { setTimeout as sleep } from "node:timers/promises";
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

/* A VIRTUAL X DISPLAY PER BROWSER, which is a change from the one display every browser used to share.
 *
 * Headed Chromium is the point of having a display at all: the headless shell is fingerprinted and turned away
 * by anti-bot WAFs (Reddit's "network security"), so the guided-login browser and the agent's @playwright/mcp
 * both run headed against an Xvfb. One shared display served that fine, because nothing ever LOOKED at the
 * display — the picture came from Chromium's own compositor over CDP, one page at a time.
 *
 * Now the picture is the display (videocast.ts grabs it, xinput.ts drives it), and a shared one stops working:
 * every browser maps its window at 0,0, so two of them overlap and a capture gets whichever is on top. Worse,
 * a pointer is a property of the X SERVER, not of a window — two browsers on one display share one cursor, and
 * an owner driving one would be moving the pointer inside the other. So a display belongs to a browser.
 *
 * They are cheap. Xvfb is a userspace X server needing no container privilege and about 15 MB of RSS, and the
 * number of them is bounded by the number of connected accounts plus one, not by traffic.
 *
 * Xvfb rides the browser capability's Dockerfile fragment, so a sandbox whose owner has never connected an
 * account has none, and every caller here has to survive that.
 */

// The X screen, and therefore the WINDOW, and therefore the picture. Chromium is launched to exactly fill it
// (--window-size) with no viewport emulation, so what the page gets is this minus the browser's own chrome —
// measured at 88px (tab strip + toolbar) on the Chromium this image pins. Nothing needs that number: input is
// in DISPLAY coordinates now, which is the whole reason the chrome can be visible without anything having to
// know how tall it is.
export const DISPLAY_WIDTH = 1280;
export const DISPLAY_HEIGHT = 880;

/* Display numbers start high and climb. :99 was the old shared one and is deliberately still the first handed
 * out, so a sandbox with a single browser looks exactly as it always did. The ceiling is a backstop against a
 * runaway rather than a real limit: production needs one display per profile owner with a browser, which is
 * bounded by the number of connected accounts. */
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
    // Held so the display can be torn down with the browser it was for. Undefined for one that was already up
    // when we found it, which is the surviving-Xvfb case: it is adopted, and adopting is not owning.
    readonly child: ChildProcess | undefined;
}

const running = new Map<string, Server>();
// One spawn per key even when several callers ask at once. Dropped as each settles, so a display that dies
// later is started again rather than remembered as up — a resolved promise is a claim about the past.
const starting = new Map<string, Promise<Display>>();

/* ALLOCATION IS SERIALIZED ACROSS KEYS, not merely deduplicated per key, and the difference is a race with a
 * silent outcome. Picking a number is "probe for one nothing answers on, then spawn there", and those are two
 * steps: two DIFFERENT keys allocating at the same moment both probe the same free number, both spawn on it,
 * and the loser's Xvfb exits while `waitForDisplay` cheerfully succeeds against the winner's. Two browsers then
 * believe they are alone on a display they share, which is exactly the overlap this module exists to prevent —
 * and it would show up as a capture of somebody else's window. One chain makes probe-then-claim atomic. */
let allocating: Promise<unknown> = Promise.resolve();

const socketPath = (number: number): string => `/tmp/.X11-unix/X${number}`;
const lockPath = (number: number): string => `/tmp/.X${number}-lock`;

/* WHOSE DISPLAY THAT IS, written beside it, and the reason this module can be restarted without leaking.
 *
 * An X server outlives the process that spawned it whenever that process does not exit cleanly — a SIGKILL, a
 * container stop, a test runner tearing a worker down. Without a way to recognise a survivor, the next daemon
 * probes, finds :99 answering, decides it is taken, and allocates :100 instead: one whole set of displays
 * orphaned per restart, and nothing that ever cleans them up. An `exit` handler is not an answer, because the
 * cases that leak are exactly the ones where handlers do not run.
 *
 * So a display is CLAIMED rather than merely taken. The claim is a file next to the X socket naming the key it
 * belongs to, and a key looks for its own claim before it looks for a free number — so a restarted daemon
 * ADOPTS the display its owner already had, browsers and all, and the count stops growing. A claim whose server
 * is dead is worth nothing and is simply overwritten when that number is reused. */
const claimPath = (number: number): string => `/tmp/.intentic-display-${number}`;

const claimedBy = (number: number): string | undefined => {
    try {
        return readFileSync(claimPath(number), "utf8").trim() || undefined;
    } catch {
        return undefined;
    }
};

/* WHETHER A DISPLAY ANSWERS, which is a different question from whether its socket file is on disk, and the
 * two disagreeing is what took every browser tool in this sandbox down once.
 *
 * An X server's socket is a FILE in /tmp, and a server that dies does not take it with it. /tmp survives a
 * container restart here, so after one the daemon found the socket exactly where it left it, read that as "the
 * display is up", and handed every launch a DISPLAY pointing at nothing. Chromium then died with "Looks like
 * you launched a headed browser without having a XServer running" on the FIRST browser tool call of every
 * turn, and the headless fallback could not save it: that path is chosen when this THROWS, and it was
 * cheerfully returning. Two files nobody could see made the agent's browser unusable until a human deleted them.
 *
 * So liveness is probed rather than inferred. A unix socket with no listener refuses the connection even though
 * the file is there, which is the whole test, and it needs no X client tools: this sandbox ships none, and
 * needing one would be a second thing that can be missing. */
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
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await answers(number)) {
            return;
        }
        await sleep(50);
    }
    throw new Error(`Xvfb did not come up on :${number} (nothing answering on ${socketPath(number)}): rebuild the sandbox to install it`);
};

const displayAt = (number: number): Display => ({ name: `:${number}`, width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT });

/* Where this key's display is, or should be. Two passes over the range, in this order and for this reason:
 *
 *   1. A LIVE server this key already claimed. That is the restart case — a display our previous life started,
 *      still running, with this owner's browsers on it. Adopting it is both cheaper than a new one and the
 *      thing that stops the count growing by a set per restart.
 *   2. Otherwise the lowest number nothing answers on. A claim left by a dead server is worth nothing, so it
 *      does not make a number taken; it is overwritten below.
 *
 * Probed rather than counted, because these servers can outlive the process that started them and a counter
 * would happily hand one browser another's display. */
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
        // Somebody's previous life started this and it is still serving this key's browsers. Nothing to spawn,
        // and nothing to own: killing a server this process did not start is not ours to do (see release).
        const display = displayAt(number);
        running.set(key, { display, child: undefined });
        return display;
    }
    /* The socket and the lock of a server that is demonstrably not there (nothing answered on this number).
     * Xvfb treats either as the display being taken and exits, so a sandbox whose /tmp survived a restart would
     * never get its displays back — two files nobody could see once made every browser tool here unusable
     * until a human deleted them. Removed only on this dead path. */
    rmSync(socketPath(number), { force: true });
    rmSync(lockPath(number), { force: true });
    // Written BEFORE the spawn, so a server that comes up is claimed from its first breath rather than from
    // whenever we got round to saying so.
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

/* Ensure a display is ANSWERING for `key` and return it. Idempotent and concurrency-safe: concurrent callers
 * share one spawn, and nothing is remembered across a death — a display that stopped answering is started
 * again rather than handed out because it once worked.
 *
 * `key` is whatever owns the browser: a profile owner for a logged-in one, `web` for the credential-free one.
 * Two calls with the same key get the same display, which is what makes an account's login window and the
 * agent's later tools land in the same place. */
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
    // Queued behind every other allocation, whatever key it was for. See `allocating`: probe-and-claim is two
    // steps, and two keys interleaving them land on the same display number.
    const attempt = allocating.then(() => start(key)).finally(() => starting.delete(key));
    starting.set(key, attempt);
    // The chain must not break on a failure: a display that would not start is this caller's problem, not a
    // reason for the next allocation to be rejected before it has tried.
    allocating = attempt.catch(() => undefined);
    return attempt;
};

// The display a key already has, without starting one. What the view route asks: it is looking at a browser
// somebody else launched, and a display that does not exist means there is nothing to capture.
export const displayOf = (key: string): Display | undefined => running.get(key)?.display;

/* Stop the display for `key`, when the browser that had it is gone. Best-effort and never awaited on a path
 * that matters: an Xvfb left running costs ~15 MB and one display number, where a teardown that throws in a
 * socket's close handler costs the close. A display we ADOPTED rather than spawned is only forgotten, since
 * killing a server this process did not start would take down whatever else is on it. */
export const releaseDisplay = (key: string): void => {
    const server = running.get(key);
    running.delete(key);
    if (server?.child === undefined) {
        return;
    }
    try {
        server.child.kill();
        // The claim goes with the server. Left behind, it would make the next allocation on that number
        // believe a dead display belonged to this key — harmless, since a claim only counts when the server
        // ANSWERS, but a lie on disk is worth not writing.
        rmSync(claimPath(Number(server.display.name.slice(1))), { force: true });
    } catch {
        // already gone, which is the outcome asked for
    }
};
