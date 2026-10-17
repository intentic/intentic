import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { INDEX_RUN_BYTE_LIMIT, INDEX_RUN_FILE_LIMIT, type IndexRunDir, type IndexRunHold } from "@intentic/sandbox-contract/schemas/git/index-run";

// The stage run's guardrail (index-run.ts): whether what a stage would take is big enough to ask about first, and if so
// which top-level directories make it big. Read from the path list the stage resolves anyway, so the count is exact.

// How many directories the question names; past a handful a list stops being read.
const NAMED_DIRS = 5;
// lstat fan-out: enough to overlap disk latency, few enough not to flood the event loop's thread pool.
const STAT_CONCURRENCY = 16;

// The top-level directory a repository-relative path sits under; "" for a file at the root.
const topDirOf = (path: string): string => {
    const slash = path.indexOf("/");
    return slash === -1 ? "" : path.slice(0, slash);
};

// Bytes on disk per path, 0 for one that is gone (a deletion stages nothing to store). Only called under the file limit,
// so the walk is bounded by it.
const sizesOf = async (dir: string, paths: readonly string[]): Promise<readonly number[]> => {
    const sizes = Array.from({ length: paths.length }, () => 0);
    let cursor = 0;
    const worker = async (): Promise<void> => {
        while (cursor < paths.length) {
            const index = cursor;
            cursor += 1;
            // allow(silent-catch): a path that vanished between status and here weighs nothing, which is what it stages.
            sizes[index] = await lstat(join(dir, paths[index]!)).then((stat) => stat.size, () => 0);
        }
    };
    await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, paths.length) }, () => worker()));
    return sizes;
};

// The directories biggest first, by bytes when measured and by files otherwise.
const largestDirs = (paths: readonly string[], sizes: readonly number[] | undefined): IndexRunDir[] => {
    const dirs = new Map<string, { files: number; bytes: number }>();
    paths.forEach((path, index) => {
        const entry = dirs.get(topDirOf(path)) ?? { files: 0, bytes: 0 };
        entry.files += 1;
        entry.bytes += sizes?.[index] ?? 0;
        dirs.set(topDirOf(path), entry);
    });
    return [...dirs.entries()]
        .map(([dir, { files, bytes }]): IndexRunDir => (sizes === undefined ? { dir, files } : { dir, files, bytes }))
        .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || b.files - a.files)
        .slice(0, NAMED_DIRS);
};

// What to hold a stage of `paths` for, or undefined when it may go ahead. Over the file limit sizes go unmeasured: the
// count alone decides, and stat-ing tens of thousands of files would cost what the guardrail is there to spare.
export const stageHold = async (dir: string, paths: readonly string[]): Promise<IndexRunHold | undefined> => {
    if (paths.length > INDEX_RUN_FILE_LIMIT) {
        return { files: paths.length, dirs: largestDirs(paths, undefined) };
    }
    const sizes = await sizesOf(dir, paths);
    const bytes = sizes.reduce((total, size) => total + size, 0);
    return bytes > INDEX_RUN_BYTE_LIMIT ? { files: paths.length, bytes, dirs: largestDirs(paths, sizes) } : undefined;
};
