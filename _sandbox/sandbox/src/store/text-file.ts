import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

// Keyed by resolved path, not per `textFile()` call: two handles on one file must share one queue, or serializing
// against "every other update" would only mean the ones that happened to use the same handle.
const queues = new Map<string, Promise<unknown>>();

export const writeTextFile = async (path: string, content: string, mode?: number): Promise<void> => {
    // Sibling, pid-tagged temp path; leading dot avoids prefix-matching the target in the watcher's path table.
    const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, content, mode === undefined ? undefined : { mode });
    await rename(tempPath, path);
};

export const textFile = (path: string, mode?: number): TextFile => {
    const key = resolve(path);
    const read = async (): Promise<string> => {
        try {
            return await readFile(path, "utf8");
        } catch {
            return "";
        }
    };
    return {
        read,
        update: (change) => {
            // The chain doubles as the write queue; a failed update still settles it so the next update runs.
            const next = (queues.get(key) ?? Promise.resolve()).then(async () => {
                const updated = change(await read());
                await writeTextFile(path, updated, mode);
                return updated;
            });
            queues.set(
                key,
                next.catch(() => undefined),
            );
            return next;
        },
    };
};
