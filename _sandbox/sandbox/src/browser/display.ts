import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// A single shared virtual X display for HEADED Chromium. Headless Chromium is fingerprinted and blocked by
// anti-bot WAFs (e.g. Reddit's "network security"), so both the guided-login browser and the agent's
// @playwright/mcp run headed against this Xvfb instead. One display serves every browser process; Xvfb is a
// userspace X server and needs no container privilege of its own. Xvfb rides the browser
// capability's Dockerfile fragment, installed on the owner's rebuild.

const DISPLAY = ":99";
const X_SOCKET = "/tmp/.X11-unix/X99";
let starting: Promise<string> | undefined;

const waitForSocket = async (): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (existsSync(X_SOCKET)) {
            return;
        }
        await sleep(50);
    }
    throw new Error("Xvfb did not come up (no X socket at /tmp/.X11-unix/X99): rebuild the sandbox to install it");
};

// Ensure Xvfb is running on :99 and return the DISPLAY value. Idempotent + concurrency-safe (one spawn, shared
// promise).
export const ensureXvfb = (): Promise<string> => {
    if (existsSync(X_SOCKET)) {
        return Promise.resolve(DISPLAY);
    }
    if (starting !== undefined) {
        return starting;
    }
    starting = (async () => {
        try {
            // -nolisten tcp: local socket only. -ac: no X access control (single-tenant sandbox). Detached +
            // unref so it outlives the spawning request and the daemon never waits on it.
            const child = spawn("Xvfb", [DISPLAY, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"], { detached: true, stdio: "ignore" });
            // Swallow ENOENT (Xvfb not installed until the owner rebuilds), it surfaces via the socket-wait timeout.
            child.on("error", () => {});
            child.unref();
            await waitForSocket();
            return DISPLAY;
        } catch (error) {
            // Clear the memo so a retry after the owner rebuilds xvfb in can succeed.
            starting = undefined;
            throw error;
        }
    })();
    return starting;
};
