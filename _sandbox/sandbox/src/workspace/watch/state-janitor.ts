import { execFile } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { statePath } from "../layout/state-paths.js";

// Garbage collection for everything under `.intentic` classified as disposable; the state table says what a tree is,
// this decides what happens to it. Every rule is derived from a class, not a judgment about content:
// - tmp/ (derived scratch) is emptied at boot, when nothing can be mid-write
// - the pnpm store is pruned via pnpm's own unreferenced-blob definition of garbage
// - browser screenshots age out after 30 days, since a transcript that outlives its images degrades to a path string

// Screenshots older than this are deleted; attachments and reports in artifacts/ stay untouched.
const SCREENSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Ceiling on `pnpm store prune` per boot, so a hung child can't hold the boot sweep's promise forever.
const PRUNE_TIMEOUT_MS = 5 * 60 * 1000;

const remove = async (path: string, log: Logger, what: string): Promise<void> => {
    try {
        await rm(path, { recursive: true, force: true });
    } catch (error) {
        // A busy file or stray permission fails just this target, not the whole sweep.
        log.warn({ err: error, path }, `state janitor: could not remove ${what}`);
    }
};

// Empties without removing the directory itself, which other writers mkdir -p around; deleting it mid-boot would race
// them.
const emptyDir = async (dir: string, log: Logger, what: string): Promise<void> => {
    const entries = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(entries.map((entry) => remove(join(dir, entry), log, what)));
};

// Top-level files only, the shape both capture dirs have: @playwright/mcp writes flat page-*/console-* files alongside
// named shots.
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

// Prunes the auto-created .intentic pnpm store; only removes blobs no node_modules links, so a missing pnpm costs
// nothing but disk.
const pruneStore = (storeDir: string, log: Logger): Promise<void> =>
    new Promise((resolve) => {
        execFile("pnpm", ["store", "prune", "--store-dir", storeDir], { timeout: PRUNE_TIMEOUT_MS }, (error) => {
            if (error !== null) {
                log.info({ err: error }, "state janitor: pnpm store prune skipped");
            }
            resolve();
        });
    });

// Boot sweep: scratch and the pnpm store, where "since last boot" is the natural cadence and mid-flight sweeping would
// race a writer.
export const sweepStateAtBoot = async (workspaceRoot: string, log: Logger): Promise<void> => {
    await emptyDir(statePath(workspaceRoot, ".intentic/local/tmp/"), log, "boot scratch");
    const storeDir = statePath(workspaceRoot, ".intentic/local/.pnpm-store/");
    if ((await stat(storeDir).catch(() => undefined))?.isDirectory() === true) {
        await pruneStore(storeDir, log);
    }
    await sweepAgedState(workspaceRoot, Date.now(), log);
};

// The recurring half; cheap enough to ride the hourly timer agent sweeps already use.
export const sweepAgedState = async (workspaceRoot: string, now: number, log: Logger): Promise<void> => {
    await sweepAgedCaptures(statePath(workspaceRoot, ".intentic/records/artifacts/", "browser"), now, log);
};
