import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

// One text file, read whole and written whole: the `jsonFile` guarantees for content that isn't JSON (`.env`).
// - atomicity: writes go to a sibling temp file and rename over the target, so a reader never sees a half-written file
// - lost updates: `update` serializes read-modify-write through a per-path queue
// A missing file reads as empty, since for every caller here "absent" and "holds nothing" are the same state.

export interface TextFile {
    // Contents, or "" if absent; not queued, since a write is never observable half-done.
    readonly read: () => Promise<string>;
    // Read-change-write, serialized against every other update of this path, returning what was written.
    readonly update: (change: (current: string) => string) => Promise<string>;
}

// Keyed by resolved path, not per handle: two handles on one file must share one queue, or serializing against "every
// other update" would only mean the ones that happened to use the same handle. Holds only paths with work queued.
const queues = new Map<string, Promise<void>>();

// Runs `task` once every task queued earlier on the same path has settled, whichever handle or store queued it. A
// failed task still settles its turn, so the next one runs.
export const queueOnFile = <T>(path: string, task: () => Promise<T>): Promise<T> => {
    const key = resolve(path);
    const next = (queues.get(key) ?? Promise.resolve()).then(task);
    const settled: Promise<void> = next
        .then(
            () => undefined,
            () => undefined,
        )
        .then(() => {
            if (queues.get(key) === settled) {
                queues.delete(key);
            }
        });
    queues.set(key, settled);
    return next;
};

// Numbers this process's writes, so two in flight to one path never share a temp file and rename a splice of both.
let writes = 0;

// Writes atomically: a sibling temp file renamed over the target. A given `mode` is the file's exact mode (the umask
// does not apply), which is what lets a caller keep the mode of the file it replaces.
export const writeTextFile = async (path: string, content: string, mode?: number): Promise<void> => {
    writes += 1;
    // Leading dot avoids prefix-matching the target in the watcher's path table.
    const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${writes}.tmp`);
    await mkdir(dirname(path), { recursive: true });
    try {
        await writeFile(tempPath, content, mode === undefined ? undefined : { mode });
        if (mode !== undefined) {
            await chmod(tempPath, mode);
        }
        await rename(tempPath, path);
    } finally {
        // Already gone after the rename; after a failure, a partial file no later write would ever reuse.
        await rm(tempPath, { force: true });
    }
};

export const textFile = (path: string, mode?: number): TextFile => {
    const read = async (): Promise<string> => {
        try {
            return await readFile(path, "utf8");
        } catch {
            return "";
        }
    };
    return {
        read,
        update: (change) =>
            queueOnFile(path, async () => {
                const updated = change(await read());
                await writeTextFile(path, updated, mode);
                return updated;
            }),
    };
};
