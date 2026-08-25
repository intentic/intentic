import type { Logger } from "pino";
import { readWorkspaceFile, writeWorkspaceFile } from "../workspace/workspace-files.js";
import { synthesizeAutoDrafts } from "./auto-drafts.js";
import { clearDriftCache, computeDrift } from "./drift.js";
import type { RuntimeInstallsStore } from "./runtime-installs.js";

/* THE DRIFT SWEEP: the timer that keeps the environment's ground truth current and lets the auto-drafter act
 * on it. Each pass is one probe (drift.ts: a dpkg.log read and one `find` walk, a second or two), one snapshot
 * persisted for the card, and one synthesis pass (auto-drafts.ts) that may write overlay drafts.
 *
 * It borrows the probe-runner's manners without its machinery — this is a single cheap job, not a fleet of
 * repo-scoped measurements, so a lane and a store would be scaffolding around a function call:
 *
 *   NEVER WHILE AGENTS WORK. Installs happen mid-turn, so mid-turn drift is a half-written story anyway; the
 *   first idle tick after the turn ends reads the finished state.
 *
 *   ALLOWED TO FAIL. A probe error is a warn and a skipped pass, never a throw into the daemon; the previous
 *   snapshot stays on the card, honestly stamped with when it was taken.
 *
 * `refresh` is the Environment card's button: it clears the probe cache and runs a pass NOW, live turns or
 * not — a person watching the card outranks the timer's politeness. */

const TICK_MS = 10 * 60_000;
// Behind the boot's own writes, and long enough that a container recreated mid-task is not immediately probing
// an environment its first turn is still installing into.
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

    // One pass at a time; a tick landing on a running pass joins it rather than stacking a second find walk.
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
