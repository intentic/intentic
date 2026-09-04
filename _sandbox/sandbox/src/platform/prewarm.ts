import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sleep } from "@intentic/base/async";
import { STARTER_APP, STARTER_REPO } from "@intentic/sandbox-contract";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import type { Logger } from "pino";
import { answers } from "../ports/port-probe.js";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import { writeJsonFile } from "../store/json-file.js";
import { appPanelKey } from "../workspace/app-previews.js";

/* PREWARM: the boot a pool machine runs before anybody owns it (SANDBOX_PREWARM=1, env.config.ts).
 *
 * The hosted lane's warm pool used to warm one thing, the image: a pool machine's first boot ran `/bin/true`,
 * which pulled the rootfs onto the host and stopped. Everything else a first boot does was left for the user's
 * clock — copying the starter site and its node_modules onto an empty volume, initialising its repo, taking
 * the root baseline, converging skills, and only then starting the dev server they were brought here to see —
 * on a shared-CPU machine whose burst allowance is spent five seconds in. Measured from a screenshot: the copy
 * alone was still running at 26 seconds, and the preview took minutes.
 *
 * None of that work depends on who the owner is. So a pool machine now boots the REAL daemon with this flag
 * set, runs the ordinary boot chain onto its volume (the same code, the same order, nothing prewarm-specific
 * in any step), waits for the starter's dev server to answer once so its dependency caches are on the volume
 * too, writes the marker below, and exits 0 — which under the hosted restart policy stops the machine. What
 * the platform then hands a new user is a stopped machine whose volume already holds everything a first boot
 * would have built, and the claimed boot finds every step already done: the root repo exists (not fresh), the
 * site repo exists (the seed skips), the baseline is committed, and the `autostart` step starts the server.
 *
 * NOTHING THAT NAMES AN OWNER RUNS, by construction rather than by branching: a pool machine's env carries no
 * CONNECT_TOKEN, no OWNER_EMAIL, no grant, no platform URL and no Google client id, so the announce, the
 * ingress dial, the idle stop and the trial refresh are all already off by their own gates, `owner.json` is
 * never written (first-bind needs a Google proof), and the setup pairings have no tokens to arm. The claim
 * replaces the machine's whole env, so the flag is gone before the owner's boot.
 *
 * A PREWARM THAT FAILS DEGRADES TO TODAY, never to breakage: the seed stages its copy and renames it in, so a
 * boot killed mid-copy leaves nothing behind; the marker is written last, so a volume without it is simply an
 * empty volume the claimed boot prepares as it always has. */

export const PREWARM_MARKER = "prewarm.json";

export interface PrewarmMarker {
    // The image this volume was prepared under. Informational: the pool already replaces a machine whose image
    // moved (hosted-pool.ts), so a claimed boot never meets a marker from another image.
    readonly image: string;
    // Whether the starter's dev server answered during the prewarm, i.e. whether its caches are on the volume.
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

/* DID THIS WORKSPACE ARRIVE AS A PREPARED VOLUME rather than as somebody's content. `workspaceArrivedEmpty`
 * (scaffold/starter-site.ts) reads the starter repo as content, which is right for a user who brought a repo
 * called `site` and wrong for a volume the platform seeded: everything gated on "did the user bring work"
 * (the definition seed) must read a prewarmed volume as empty. The marker says the daemon put the site there;
 * the directory listing says nothing else has been added since. */
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

// How long the prewarm waits for the starter's dev server to answer before giving up on the warm-up. Generous:
// this machine's CPU is throttled and its first framework start builds a dependency cache. A miss costs the
// claimed boot that cache and nothing else.
const WARMUP_MAX_MS = 120_000;
const WARMUP_POLL_MS = 2_000;

/* Wait until the starter's dev server answers on its assigned port, once. The point is the side effect: a
 * framework's first `dev` writes its pre-bundled dependencies next to node_modules, and that write is what a
 * claimed boot would otherwise pay. False when nothing was started (a seed that skipped), when the server died
 * (the manager untracks a dead session), or when the deadline passed. */
export const warmUpStarter = async (processes: ManagedProcesses, logger: Logger): Promise<boolean> => {
    const key = appPanelKey(STARTER_REPO, STARTER_APP);
    const deadline = Date.now() + WARMUP_MAX_MS;
    while (Date.now() < deadline) {
        const port = processes.portOf(key);
        if (port === undefined) {
            logger.info({ key }, "prewarm: the starter's dev server is not running, nothing to warm up");
            return false;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- a poll is the shape of this wait
        if (await answers("http", port)) {
            return true;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop
        await sleep(WARMUP_POLL_MS);
    }
    logger.warn({ key, waitedMs: WARMUP_MAX_MS }, "prewarm: the starter's dev server did not answer in time; its caches stay cold");
    return false;
};

/* The prewarm's last act: warm the starter, stamp the volume, and let the caller stop the daemon. The marker
 * goes last on purpose (see the module note): a volume is prepared when it says so, and never before. */
export const finishPrewarm = async (deps: {
    readonly historyRoot: string;
    readonly image: string;
    readonly processes: ManagedProcesses;
    readonly logger: Logger;
}): Promise<void> => {
    const warmedUp = await warmUpStarter(deps.processes, deps.logger);
    const marker: PrewarmMarker = { image: deps.image, warmedUp, at: new Date().toISOString() };
    await writeJsonFile(join(deps.historyRoot, PREWARM_MARKER), marker);
    deps.logger.info({ warmedUp, image: deps.image }, "prewarm: volume prepared, stopping so the machine can be claimed");
};
