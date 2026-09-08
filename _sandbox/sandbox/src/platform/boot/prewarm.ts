import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sleep } from "@intentic/base/async";
import { STARTER_REPO } from "@intentic/sandbox-contract";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import type { Logger } from "pino";
import type { ManagedProcesses } from "../../processes/managed-processes.js";
import { writeJsonFile } from "../../store/json-file.js";

// Boots a pool machine (SANDBOX_PREWARM=1) through the ordinary boot chain before anyone owns it, so a claimed
// machine's volume already has the starter copied, caches warmed, and a baseline committed. The env carries no owner
// identity, so owner-gated steps stay off on their own; a failed prewarm just leaves the marker unwritten, never
// breakage.

export const PREWARM_MARKER = "prewarm.json";

export interface PrewarmMarker {
    // Image this volume was prepared under; informational, since the pool replaces a machine whose image has moved.
    readonly image: string;
    // True when the starter's dev server answered during prewarm, meaning its caches are already on the volume.
    readonly warmedUp: boolean;
    readonly at: string;
}

export const readPrewarmMarker = async (historyRoot: string): Promise<PrewarmMarker | undefined> => {
    try {
        const parsed = JSON.parse(await readFile(join(historyRoot, PREWARM_MARKER), "utf8")) as Partial<PrewarmMarker>;
        return typeof parsed.image === "string" && typeof parsed.warmedUp === "boolean" && typeof parsed.at === "string"
            ? { image: parsed.image, warmedUp: parsed.warmedUp, at: parsed.at }
            : undefined;
    } catch {
        return undefined;
    }
};

// Whether this workspace arrived as a volume the daemon prepared rather than as a user's own content: the marker says
// the daemon seeded it, and the directory listing confirms nothing else has been added since.
export const arrivedPrewarmed = async (root: string, historyRoot: string): Promise<boolean> => {
    if ((await readPrewarmMarker(historyRoot)) === undefined) {
        return false;
    }
    try {
        return readdirSync(root).every((entry) => entry.startsWith(".") || entry === REFERENCE_DIR || entry === STARTER_REPO);
    } catch {
        return false;
    }
};

// Longest the prewarm waits for the starter's dev server to answer; generous, since a first framework start builds a
// cache.
const WARMUP_MAX_MS = 120_000;
const WARMUP_POLL_MS = 2_000;

// Passed in rather than imported: platform sits below ports and workspace in the import graph, and main.ts is the one
// place that already knows both.
export interface StarterProbe {
    // Process-manager key the starter's dev server runs under (workspace/app-previews.ts `appPanelKey`).
    readonly starterKey: string;
    // Whether anything answers HTTP on a local port (ports/port-probe.ts `answers`).
    readonly answers: (port: number) => Promise<boolean>;
}

// Waits until the starter's dev server answers once, so its first-run dependency cache is written now instead of during
// a claimed boot. False if nothing was started, the server died, or the deadline passed.
export const warmUpStarter = async (deps: StarterProbe & { readonly processes: ManagedProcesses; readonly logger: Logger }): Promise<boolean> => {
    const { starterKey: key, logger } = deps;
    const deadline = Date.now() + WARMUP_MAX_MS;
    while (Date.now() < deadline) {
        const port = deps.processes.portOf(key);
        if (port === undefined) {
            logger.info({ key }, "prewarm: the starter's dev server is not running, nothing to warm up");
            return false;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- a poll is the shape of this wait
        if (await deps.answers(port)) {
            return true;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop
        await sleep(WARMUP_POLL_MS);
    }
    logger.warn({ key, waitedMs: WARMUP_MAX_MS }, "prewarm: the starter's dev server did not answer in time; its caches stay cold");
    return false;
};

// Warms the starter, stamps the volume, and lets the caller stop the daemon. The marker is written last: a volume
// counts as prepared only once this returns.
export const finishPrewarm = async (
    deps: StarterProbe & {
        readonly historyRoot: string;
        readonly image: string;
        readonly processes: ManagedProcesses;
        readonly logger: Logger;
    },
): Promise<void> => {
    const warmedUp = await warmUpStarter(deps);
    const marker: PrewarmMarker = { image: deps.image, warmedUp, at: new Date().toISOString() };
    await writeJsonFile(join(deps.historyRoot, PREWARM_MARKER), marker);
    deps.logger.info({ warmedUp, image: deps.image }, "prewarm: volume prepared, stopping so the machine can be claimed");
};
