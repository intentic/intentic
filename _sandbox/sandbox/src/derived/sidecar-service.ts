import { execFile } from "node:child_process";
import type { Logger } from "pino";
import { isCandidatePath } from "@intentic/fileq/formats";
import { stateRelPath } from "../workspace/state-paths.js";

/* THE EAGER HALF OF FILEQ: markdown shadows of binary workspace files, converged in the BACKGROUND so a
 * reasoning-time read hits a sidecar that already exists instead of paying a parse mid-task. The lazy half
 * is the fileq CLI itself (baked on PATH, taught by its skill); this service is only the trigger that runs
 * it unasked, and it is gated by the `sidecars` setting because unasked CPU is the owner's call.
 *
 * It rides the same watcher push everything else does (workspace-watch.ts): a batch that touched a candidate
 * file (pre-filtered through @intentic/fileq/formats, the CLI's OWN table, so the filter and the routing
 * cannot disagree) queues a `fileq derive` of exactly those paths — which also covers DELETION, because
 * derive on a vanished source removes its orphaned shadow. Two cases get a whole-workspace `fileq sweep`
 * instead: the moment the setting turns on (files that predate the feature deserve shadows too), and the
 * watcher's "too many paths, just refetch" empty batch, where the path list is gone but the tree changed.
 *
 * ONE CHILD AT A TIME, whisper's rule for whisper's reason: derivation shares the box with the agent whose
 * files it is shadowing. Batches that land mid-run accumulate and go out as the next run. The child is the
 * isolation boundary too — a hostile document is parsed in a process the daemon merely times out, never in
 * the daemon. A missing binary (a dev daemon outside the image) downgrades the service to a one-line warning
 * rather than a per-batch error loop. */

export type ExecFn = (command: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
const defaultExec: ExecFn = (command, args, options) =>
    new Promise((resolve, reject) => {
        execFile(command, args, options, (error, stdout) => (error === null ? resolve({ stdout }) : reject(error)));
    });

// A sweep parses every document in the workspace; a derive parses one batch. Both are hang bounds, not
// latency expectations (a document-heavy tree legitimately sweeps for minutes).
const SWEEP_TIMEOUT_MS = 15 * 60_000;
const DERIVE_TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;
// Paths per derive spawn: enough to swallow a big paste of documents, small enough that argv stays sane.
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
            // Off→on (or boot with it on): the watcher never saw the files that already exist, sweep for them.
            sweepWanted = true;
        }
        lastEnabled = enabled;
        if (!enabled) {
            // Dropped rather than kept: the enabling transition sweeps the whole tree anyway, and a set that
            // grows for weeks while the feature is off is a leak with no reader.
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
                // A batch bigger than one argv's worth: the remainder is real work, not leftovers for the
                // next filesystem event to happen to flush.
                schedule();
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                // Not an image (a dev checkout without fileq on PATH): say so once and stand down.
                broken = true;
                deps.logger.warn("sidecars: fileq is not on PATH, background derivation is off until restart");
                return;
            }
            // Exit 1 is fileq's "nothing here was derivable", which a raced deletion can honestly produce.
            if ((error as { code?: number | string }).code !== 1) {
                deps.logger.warn({ err: error }, "sidecars: derivation failed");
            }
        }
    };

    const schedule = (): void => {
        queue = queue.then(run, run);
    };

    // Boot pass: with the setting already on this is what sweeps the pre-existing tree.
    schedule();

    return subscribe((paths) => {
        if (broken) {
            return;
        }
        if (paths.length === 0) {
            // The >MAX_PATHS "just refetch the tree" frame: the list is gone, converge the whole tree.
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
        // A save of the settings file re-reads the gate, which is how flipping the switch takes effect
        // (and how the off→on transition's sweep fires) without a restart.
        if (relevant || paths.includes(SETTINGS_FILE)) {
            schedule();
        }
    });
};
