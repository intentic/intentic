import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { DAEMON_CONTAINER, unseed } from "./stack.js";

// Undo exactly what global-setup started: kill the spawned server process groups, remove the daemon container,
// drop the seeded rows. Postgres (compose) is left running, it's the same dev database `pnpm dev` uses.

const run = promisify(execFile);
const cacheDir = join(import.meta.dirname, `.cache`);

export default async (): Promise<void> => {
    const state = (() => {
        try {
            return JSON.parse(readFileSync(join(cacheDir, `stack-state.json`), `utf8`)) as {
                apiPid?: number;
                webPid?: number;
                daemonStarted?: boolean;
            };
        } catch {
            return {};
        }
    })();

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
    await unseed().catch(() => undefined);
    rmSync(join(cacheDir, `stack-state.json`), { force: true });
};
