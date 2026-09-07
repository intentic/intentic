import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { promisify } from "node:util";
import type { FakeStripe } from "@intentic/testing/stripe-fake";
import { DAEMON_CONTAINER, readStackState, STACK_STATE_FILE, unseed } from "./stack.js";

// Undo exactly what global-setup started: kill the spawned server process groups, remove the daemon container,
// close the Stripe stand-in, drop the seeded rows. Postgres (compose) is left running, it's the same dev
// database `pnpm dev` uses.

const run = promisify(execFile);

export default async (): Promise<void> => {
    const state = readStackState();

    for (const pid of [state.apiPid, state.webPid]) {
        if (pid !== undefined) {
            try {
                process.kill(-pid, `SIGTERM`);
            } catch {
                // Already gone.
            }
        }
    }
    if (state.daemonStarted === true) {
        await run(`docker`, [`rm`, `-f`, DAEMON_CONTAINER]).catch(() => undefined);
    }
    // Started in this very process by global-setup, so it is closed here rather than signalled.
    await (globalThis as { intenticFakeStripe?: FakeStripe }).intenticFakeStripe?.close().catch(() => undefined);
    await unseed().catch(() => undefined);
    rmSync(STACK_STATE_FILE, { force: true });
};
