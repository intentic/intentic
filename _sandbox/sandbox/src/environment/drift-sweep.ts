import type { Logger } from "pino";
import { readWorkspaceFile, writeWorkspaceFile } from "../workspace/files/workspace-files.js";
import { synthesizeAutoDrafts } from "./auto-drafts.js";
import { clearDriftCache, computeDrift } from "./drift.js";
import type { RuntimeInstallsStore } from "./runtime-installs.js";

// Timer keeping the environment's ground truth current for the auto-drafter: one probe, one saved snapshot, one
// synthesis pass per tick.
// - never while agents work: mid-turn drift is a half-written story, so the first idle tick after a turn reads the
//   finished state.
// - allowed to fail: a probe error is a warn and a skipped pass, never a throw; the previous snapshot stays on the
//   card.
// `refresh` is the card's button: clears the cache and runs a pass now, regardless of live turns.

const TICK_MS = 10 * 60_000;
// Behind boot's own writes, so a just-recreated container isn't probed while its first turn still installs.
const WARMUP_MS = 90_000;

export interface DriftSweepDeps {
    readonly workspace: { readonly root: string };
    readonly runtimeInstalls: RuntimeInstallsStore;
    readonly agents: { readonly liveSessionIds: () => readonly string[] };
    readonly logger: Logger;
}

export interface DriftSweep {
    readonly start: () => void;
    readonly stop: () => void;
    readonly refresh: () => Promise<void>;
}

export const createDriftSweep = (deps: DriftSweepDeps): DriftSweep => {
    const workspaceFiles = { workspace: deps.workspace, files: { read: readWorkspaceFile, write: writeWorkspaceFile } };

    // One pass at a time; a tick during a running pass joins it instead of stacking a second find walk.
    let running: Promise<void> | undefined;
    const pass = async (): Promise<void> => {
        try {
            const drift = await computeDrift();
            await deps.runtimeInstalls.saveDrift(drift);
            const drafted = await synthesizeAutoDrafts(workspaceFiles, await deps.runtimeInstalls.read(), drift);
            if (drafted.length > 0) {
                deps.logger.info({ drafted }, "environment: drafted overlay steps from recurring runtime installs");
            }
        } catch (error) {
            deps.logger.warn({ err: error }, "environment: drift sweep failed");
        }
    };
    const run = (): Promise<void> => {
        running ??= pass().finally(() => (running = undefined));
        return running;
    };

    const tick = (): void => {
        if (deps.agents.liveSessionIds().length > 0) {
            return;
        }
        void run();
    };

    let timer: NodeJS.Timeout | undefined;
    return {
        start: () => {
            timer ??= setTimeout(() => {
                tick();
                timer = setInterval(tick, TICK_MS);
                timer.unref();
            }, WARMUP_MS);
            timer.unref();
        },
        stop: () => {
            if (timer !== undefined) {
                clearTimeout(timer);
                clearInterval(timer);
                timer = undefined;
            }
        },
        refresh: () => {
            clearDriftCache();
            return run();
        },
    };
};
