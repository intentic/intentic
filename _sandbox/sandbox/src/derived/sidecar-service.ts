import type { Logger } from "pino";
import { isCandidatePath } from "@intentic/fileq/formats";
import type { DerivedState, SidecarStatus } from "@intentic/sandbox-contract";
import { stateRelPath } from "../workspace/layout/state-paths.js";
import { defaultExec, FILEQ_MAX_BUFFER, isMissingBinary, type ExecFn } from "./fileq.js";

// Background half of fileq: converges markdown shadows of binary files so a reasoning-time read finds one ready, gated
// by `sidecars`. A batch triggers `fileq derive` (handles deletion too); enabling or an oversized batch triggers a
// sweep. One child at a time, isolated from the agent; a missing binary downgrades to a warning.
// It also reports itself, because nothing else can: shadows are written under the state directory the watcher ignores,
// so a file's text landing is invisible to every other signal the daemon sends.

// Hang bounds, not latency expectations; a document-heavy tree can legitimately sweep for minutes.
const SWEEP_TIMEOUT_MS = 15 * 60_000;
const DERIVE_TIMEOUT_MS = 5 * 60_000;
// Paths per derive spawn: enough for a big paste of documents, small enough that argv stays sane.
const MAX_PATHS_PER_RUN = 100;

const SETTINGS_FILE = stateRelPath(".intentic/config/settings.json");

export interface SidecarServiceDeps {
    readonly enabled: () => Promise<boolean>;
    readonly logger: Logger;
    readonly exec?: ExecFn;
}

/** A running background pass, and the two questions anything else asks of it: how it is doing, and what just landed. */
export interface SidecarService {
    readonly stop: () => void;
    readonly status: () => SidecarStatus;
    /** Fires with the paths whose shadows were just rewritten; an empty array means a sweep touched too many to list. */
    readonly onDerived: (listener: (paths: string[]) => void) => () => void;
}

interface RunningService extends SidecarService {
    readonly isPending: (relPath: string) => boolean;
}

// Module-level handle, matching the workspace watcher next door: routes need to reach the running service without the
// composition root threading it through every layer, and there is exactly one per daemon.
let current: RunningService | undefined;

// Listeners registered before the service started, adopted by it at startup; the /events stream is wired in a different
// boot step than the watcher, and which lands first is not this module's business.
const earlyListeners = new Set<(paths: string[]) => void>();

// What a daemon with no service running answers. `enabled: false` here means "nothing is rendering", which is true
// before boot finishes even when the setting itself says otherwise; `state` never reports `off` from this alone.
const IDLE_STATUS: SidecarStatus = { enabled: false, queued: 0, deriving: [], sweeping: false, broken: false };

/** How the background pass is doing, for any route that has to report on it. */
export const sidecarStatus = (): SidecarStatus => current?.status() ?? IDLE_STATUS;

/** Where one file stands with that pass, which is what a reader looking at a missing shadow is really asking. */
export const sidecarStateOf = (relPath: string, derivable: boolean): DerivedState => {
    if (!derivable) {
        return "undeliverable";
    }
    const status = sidecarStatus();
    if (status.broken) {
        return "broken";
    }
    if (status.deriving.includes(relPath)) {
        return "deriving";
    }
    if (!status.enabled) {
        return "off";
    }
    // A sweep derives everything it finds, so a file with no shadow yet is waiting on it by definition.
    return status.sweeping || current?.isPending(relPath) === true ? "queued" : "idle";
};

/** Subscribes to shadows landing. Safe before the service starts: the listener is adopted by whichever one starts. */
export const subscribeDerived = (listener: (paths: string[]) => void): (() => void) => {
    earlyListeners.add(listener);
    const detach = current?.onDerived(listener);
    return () => {
        earlyListeners.delete(listener);
        detach?.();
    };
};

export const startSidecarService = (deps: SidecarServiceDeps, subscribe: (listener: (paths: string[]) => void) => () => void): SidecarService => {
    const exec = deps.exec ?? defaultExec;
    const pending = new Set<string>();
    // The batch handed to the child right now, which is what makes "being read" a different answer from "waiting".
    let inFlight: readonly string[] = [];
    let sweeping = false;
    let sweptAt: string | undefined;
    let shadows: number | undefined;
    let sweepWanted = false;
    let lastEnabled: boolean | undefined;
    let broken = false;
    let queue: Promise<unknown> = Promise.resolve();
    const listeners = new Set<(paths: string[]) => void>(earlyListeners);

    const status = (): SidecarStatus => ({
        enabled: lastEnabled === true,
        queued: pending.size,
        deriving: [...inFlight],
        sweeping,
        broken,
        ...(shadows === undefined ? {} : { shadows }),
        ...(sweptAt === undefined ? {} : { sweptAt }),
    });

    // Announced after the state that describes it has settled, so a listener reading `status()` sees the run it is being
    // told about as finished rather than still in flight.
    const announce = (paths: string[]): void => {
        for (const listener of listeners) {
            try {
                listener(paths);
            } catch (error) {
                deps.logger.warn({ err: error }, "sidecars: a listener threw");
            }
        }
    };

    // `{"derived":1,"fresh":87,...}` — the two that exist afterwards are what a person means by "how many shadows".
    const countShadows = (stdout: string): number | undefined => {
        try {
            const summary: unknown = JSON.parse(stdout.trim());
            const { derived, fresh } = summary as { derived?: unknown; fresh?: unknown };
            return typeof derived === "number" && typeof fresh === "number" ? derived + fresh : undefined;
        } catch {
            return undefined;
        }
    };

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
                sweeping = true;
                try {
                    const { stdout } = await exec("fileq", ["sweep", "--json"], { timeout: SWEEP_TIMEOUT_MS, maxBuffer: FILEQ_MAX_BUFFER });
                    deps.logger.info({ result: stdout.trim() }, "sidecars: sweep");
                    shadows = countShadows(stdout);
                    sweptAt = new Date().toISOString();
                } finally {
                    sweeping = false;
                }
                // Empty: a sweep rewrites whatever it found stale and does not report which, so "assume everything".
                announce([]);
                return;
            }
            const batch = [...pending].slice(0, MAX_PATHS_PER_RUN);
            batch.forEach((path) => pending.delete(path));
            if (batch.length === 0) {
                return;
            }
            inFlight = batch;
            try {
                await exec("fileq", ["derive", ...batch], { timeout: DERIVE_TIMEOUT_MS, maxBuffer: FILEQ_MAX_BUFFER });
            } finally {
                inFlight = [];
            }
            deps.logger.debug({ paths: batch.length }, "sidecars: derived");
            announce(batch);
            if (pending.size > 0) {
                // A batch bigger than one argv is real remaining work, not leftovers for the next event to flush.
                schedule();
            }
        } catch (error) {
            inFlight = [];
            if (isMissingBinary(error)) {
                // Not an image (dev checkout without fileq on PATH): say so once and stand down.
                broken = true;
                pending.clear();
                deps.logger.warn("sidecars: fileq is not on PATH, background derivation is off until restart");
                // Announced so every surface offering to wait for a shadow stops offering it.
                announce([]);
                return;
            }
            // Exit 1 is fileq's 'nothing derivable', which a raced deletion can honestly produce.
            if ((error as { code?: number | string }).code !== 1) {
                deps.logger.warn({ err: error }, "sidecars: derivation failed");
            }
            // Still announced: a failed run changes what a reader is waiting for, and silence would leave them waiting.
            announce([]);
        }
    };

    const schedule = (): void => {
        queue = queue.then(run, run);
    };

    // Boot pass: sweeps the pre-existing tree if the setting is already on.
    schedule();

    const unsubscribe = subscribe((paths) => {
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

    const service: RunningService = {
        stop: () => {
            unsubscribe();
            listeners.clear();
            if (current === service) {
                current = undefined;
            }
        },
        status,
        isPending: (relPath) => pending.has(relPath),
        onDerived: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    current = service;
    return service;
};
