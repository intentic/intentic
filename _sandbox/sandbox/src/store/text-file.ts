import { readFile } from "node:fs/promises";
import { undefinedIfMissing } from "@intentic/base/errors";
import { queueOnFile, writeFileAtomic } from "@intentic/base/fs";

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

export const textFile = (path: string, mode?: number): TextFile => {
    // Only absence reads as empty: a file that exists but cannot be read would otherwise be replaced by `change("")`.
    const read = async (): Promise<string> => (await readFile(path, "utf8").catch(undefinedIfMissing)) ?? "";
    return {
        read,
        update: (change) =>
            queueOnFile(path, async () => {
                const updated = change(await read());
                await writeFileAtomic(path, updated, mode);
                return updated;
            }),
    };
};
