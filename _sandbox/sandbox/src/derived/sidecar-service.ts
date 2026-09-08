import { execFile } from "node:child_process";
import type { Logger } from "pino";
import { isCandidatePath } from "@intentic/fileq/formats";
import { stateRelPath } from "../workspace/layout/state-paths.js";

// Background half of fileq: converges markdown shadows of binary files so a reasoning-time read finds one ready, gated
// by `sidecars`. A batch triggers `fileq derive` (handles deletion too); enabling or an oversized batch triggers a
// sweep. One child at a time, isolated from the agent; a missing binary downgrades to a warning.

export type ExecFn = (command: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
const defaultExec: ExecFn = (command, args, options) =>
    new Promise((resolve, reject) => {
        execFile(command, args, options, (error, stdout) => (error === null ? resolve({ stdout }) : reject(error)));
    });

// Hang bounds, not latency expectations; a document-heavy tree can legitimately sweep for minutes.
const SWEEP_TIMEOUT_MS = 15 * 60_000;
const DERIVE_TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;
// Paths per derive spawn: enough for a big paste of documents, small enough that argv stays sane.
const MAX_PATHS_PER_RUN = 100;

const SETTINGS_FILE = stateRelPath(".intentic/config/settings.json");

export interface SidecarServiceDeps {
    readonly enabled: () => Promise<boolean>;
    readonly logger: Logger;
    readonly exec?: ExecFn;
}

export const startSidecarService = (deps: SidecarServiceDeps, subscribe: (listener: (paths: string[]) => void) => () => void): (() => void) => {
    const exec = deps.exec ?? defaultExec;
    const pending = new Set<string>();
    let sweepWanted = false;
    let lastEnabled: boolean | undefined;
    let broken = false;
    let queue: Promise<unknown> = Promise.resolve();

    const run = async (): Promise<void> => {
        if (broken) {
            return;
        }
        const enabled = await deps.enabled();
        if (enabled && lastEnabled !== true) {
            // Off->on (or boot already on): the watcher never saw pre-existing files, so sweep for them.
            sweepWanted = true;
        }
        lastEnabled = enabled;
        if (!enabled) {
            // Dropped, not kept: enabling sweeps the whole tree anyway, and a growing set while off is a leak.
            pending.clear();
            sweepWanted = false;
            return;
        }
        try {
            if (sweepWanted) {
                sweepWanted = false;
                pending.clear();
                const { stdout } = await exec("fileq", ["sweep", "--json"], { timeout: SWEEP_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
                deps.logger.info({ result: stdout.trim() }, "sidecars: sweep");
                return;
            }
            const batch = [...pending].slice(0, MAX_PATHS_PER_RUN);
            batch.forEach((path) => pending.delete(path));
            if (batch.length === 0) {
                return;
            }
            await exec("fileq", ["derive", ...batch], { timeout: DERIVE_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
            if (pending.size > 0) {
                // A batch bigger than one argv is real remaining work, not leftovers for the next event to flush.
                schedule();
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                // Not an image (dev checkout without fileq on PATH): say so once and stand down.
                broken = true;
                deps.logger.warn("sidecars: fileq is not on PATH, background derivation is off until restart");
                return;
            }
            // Exit 1 is fileq's 'nothing derivable', which a raced deletion can honestly produce.
            if ((error as { code?: number | string }).code !== 1) {
                deps.logger.warn({ err: error }, "sidecars: derivation failed");
            }
        }
    };

    const schedule = (): void => {
        queue = queue.then(run, run);
    };

    // Boot pass: sweeps the pre-existing tree if the setting is already on.
    schedule();

    return subscribe((paths) => {
        if (broken) {
            return;
        }
        if (paths.length === 0) {
            // The >MAX_PATHS 'just refetch' frame: the path list is gone, so converge the whole tree.
            sweepWanted = true;
            schedule();
            return;
        }
        let relevant = false;
        for (const path of paths) {
            if (isCandidatePath(path)) {
                pending.add(path);
                relevant = true;
            }
        }
        // A settings-file save re-reads the gate, so flipping the switch takes effect without a restart.
        if (relevant || paths.includes(SETTINGS_FILE)) {
            schedule();
        }
    });
};
