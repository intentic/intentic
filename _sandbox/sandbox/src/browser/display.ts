import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { connect } from "node:net";

// A single shared virtual X display for HEADED Chromium. Headless Chromium is fingerprinted and blocked by
// anti-bot WAFs (e.g. Reddit's "network security"), so both the guided-login browser and the agent's
// @playwright/mcp run headed against this Xvfb instead. One display serves every browser process; Xvfb is a
// userspace X server and needs no container privilege of its own. Xvfb rides the browser
// capability's Dockerfile fragment, installed on the owner's rebuild.

const DISPLAY = ":99";
const X_SOCKET = "/tmp/.X11-unix/X99";
// Xvfb's own claim on the display number. It refuses to start while this file names a server, which is why a
// restart cannot simply spawn over the wreckage of the last one.
const X_LOCK = "/tmp/.X99-lock";
let starting: Promise<string> | undefined;

/* WHETHER THE DISPLAY ANSWERS, which is a different question from whether its socket file is on disk, and the
 * two disagreeing is what took every browser tool in this sandbox down.
 *
 * An X server's socket is a FILE in /tmp, and a server that dies does not take it with it. /tmp survives a
 * container restart here, so after one the daemon found `/tmp/.X11-unix/X99` exactly where it left it, read that
 * as "Xvfb is up", and handed every launch a DISPLAY pointing at nothing. Chromium then died with "Looks like
 * you launched a headed browser without having a XServer running" on the FIRST browser tool call of every turn,
 * and the headless fallback below could not save it: that path is chosen when this function THROWS, and it was
 * cheerfully returning. Two files nobody could see made the agent's browser unusable until a human deleted them.
 *
 * So liveness is probed rather than inferred. A unix socket with no listener refuses the connection even though
 * the file is there, which is the whole test, and it costs a loopback connect on a path that runs once a turn.
 * No X client tools are needed for it: this sandbox ships none, and needing one would be a second thing that can
 * be missing. */
const displayAnswers = (): Promise<boolean> =>
    new Promise((resolve) => {
        const socket = connect(X_SOCKET);
        const settle = (answer: boolean): void => {
            socket.destroy();
            resolve(answer);
        };
        socket.once("connect", () => settle(true));
        socket.once("error", () => settle(false));
        // A socket that neither connects nor refuses is not a display anything should be launched against.
        socket.setTimeout(500, () => settle(false));
    });

const waitForDisplay = async (): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await displayAnswers()) {
            return;
        }
        await sleep(50);
    }
    throw new Error("Xvfb did not come up (nothing answering on /tmp/.X11-unix/X99): rebuild the sandbox to install it");
};

const start = async (): Promise<string> => {
    // The socket and the lock of the server that is demonstrably not there (see displayAnswers). Xvfb treats
    // either as the display being taken and exits, so a sandbox that restarted would never get its display
    // back. Removed only on the dead path: a live display is answered above and never reaches here.
    rmSync(X_SOCKET, { force: true });
    rmSync(X_LOCK, { force: true });
    // -nolisten tcp: local socket only. -ac: no X access control (single-tenant sandbox). Detached +
    // unref so it outlives the spawning request and the daemon never waits on it.
    const child = spawn("Xvfb", [DISPLAY, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"], { detached: true, stdio: "ignore" });
    // Swallow ENOENT (Xvfb not installed until the owner rebuilds), it surfaces via the display-wait timeout.
    child.on("error", () => {});
    child.unref();
    await waitForDisplay();
    return DISPLAY;
};

/* Ensure Xvfb is ANSWERING on :99 and return the DISPLAY value. Idempotent and concurrency-safe: concurrent
 * callers share one spawn, and the memo is dropped once that spawn settles rather than kept, so a display that
 * dies later is started again instead of being remembered as up. That memory was the other half of the bug
 * above: a resolved promise is a claim about the past. */
export const ensureXvfb = async (): Promise<string> => {
    if (await displayAnswers()) {
        return DISPLAY;
    }
    starting ??= start().finally(() => {
        starting = undefined;
    });
    return starting;
};
