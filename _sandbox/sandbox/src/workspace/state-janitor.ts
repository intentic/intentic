import { execFile } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { statePath } from "./state-paths.js";

/* THE STATE DIR'S GARBAGE COLLECTOR, the missing half of classifying everything under `.intentic`.
 *
 * The state table says what each tree IS; nothing said what happens to the ones whose class means "disposable".
 * So nothing happened: the workspace this module was written against carried 1.3 GB of pnpm store no install
 * pointed at, 3 400 browser screenshots, and a tmp/ of build logs from turns long finished, state whose own
 * classification already called it rebuildable, waiting for a manual `rm` nobody would ever run.
 *
 * Every rule here is DERIVED from a class, not from a judgment about content:
 *   - tmp/ is `derived` scratch and its entry says the janitor empties it, at boot, when nothing can be
 *     mid-write in it because no turn has started.
 *   - the pnpm store is content-addressable and `pnpm store prune` removes only unreferenced blobs, the
 *     vendor's own definition of garbage.
 *   - browser screenshots are the one AGE rule: they are artifacts (carried, owned by conversations), but a
 *     capture exists to be Read back within the turn that took it, and a transcript that outlives its images
 *     by a month degrades to a path string. Thirty days keeps every capture anyone revisits.
 */

// Screenshots older than this are deleted; everything else in artifacts/ is untouched (attachments are the
// owner's uploads, reports are records). Measured against file mtime, a capture is written once, never touched.
const SCREENSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// How long `pnpm store prune` may run before the janitor gives up on it for this boot. It walks hash dirs on
// the workspace volume; minutes is plenty, and a hung child must not hold the boot sweep's promise forever.
const PRUNE_TIMEOUT_MS = 5 * 60 * 1000;

const remove = async (path: string, log: Logger, what: string): Promise<void> => {
    try {
        await rm(path, { recursive: true, force: true });
    } catch (error) {
        // A busy file (or a permission oddity a container rebuild left behind) fails ONE target, not the sweep.
        log.warn({ err: error, path }, `state janitor: could not remove ${what}`);
    }
};

// Empty a directory without removing it: the dir itself is furniture other writers mkdir -p around, and
// deleting it mid-boot would race whoever recreates it.
const emptyDir = async (dir: string, log: Logger, what: string): Promise<void> => {
    const entries = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(entries.map((entry) => remove(join(dir, entry), log, what)));
};

// Age out screenshots: top-level files only, which is the shape both capture dirs actually have, @playwright/mcp
// writes flat page-*/console-* files and named shots beside them.
const sweepAgedCaptures = async (dir: string, now: number, log: Logger): Promise<void> => {
    const entries = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(
        entries.map(async (entry) => {
            const path = join(dir, entry);
            const stats = await stat(path).catch(() => undefined);
            if (stats?.isFile() === true && now - stats.mtimeMs > SCREENSHOT_RETENTION_MS) {
                await remove(path, log, "an aged browser capture");
            }
        }),
    );
};

// `pnpm store prune` against the store installs from under .intentic auto-created. Only ever removes blobs no
// node_modules links, so a missing pnpm or a refusal costs nothing but the disk it would have freed.
const pruneStore = (storeDir: string, log: Logger): Promise<void> =>
    new Promise((resolve) => {
        execFile("pnpm", ["store", "prune", "--store-dir", storeDir], { timeout: PRUNE_TIMEOUT_MS }, (error) => {
            if (error !== null) {
                log.info({ err: error }, "state janitor: pnpm store prune skipped");
            }
            resolve();
        });
    });

/* The boot sweep: scratch and the pnpm store, the things where "since last boot" is the natural cadence and
 * where sweeping mid-flight could race a writer. */
export const sweepStateAtBoot = async (workspaceRoot: string, log: Logger): Promise<void> => {
    await emptyDir(statePath(workspaceRoot, ".intentic/local/tmp/"), log, "boot scratch");
    const storeDir = statePath(workspaceRoot, ".intentic/local/.pnpm-store/");
    if ((await stat(storeDir).catch(() => undefined))?.isDirectory() === true) {
        await pruneStore(storeDir, log);
    }
    await sweepAgedState(workspaceRoot, Date.now(), log);
};

// The recurring half, cheap enough for the hourly timer the agent sweeps already run on.
export const sweepAgedState = async (workspaceRoot: string, now: number, log: Logger): Promise<void> => {
    await sweepAgedCaptures(statePath(workspaceRoot, ".intentic/records/artifacts/", "browser"), now, log);
};
