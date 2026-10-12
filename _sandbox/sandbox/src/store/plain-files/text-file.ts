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
    // Read-change-write, serialized against every other update of this path, returning what the file now holds. A change
    // that answers undefined leaves the file as it is: not rewritten, not created, its mtime unmoved, which is how a
    // caller whose file a watcher or a review reads says "already right" without a second, unqueued read.
    readonly update: (change: (current: string) => string | undefined) => Promise<string>;
}

export const textFile = (path: string, mode?: number): TextFile => {
    // Only absence reads as empty: a file that exists but cannot be read would otherwise be replaced by `change("")`.
    const read = async (): Promise<string> => (await readFile(path, "utf8").catch(undefinedIfMissing)) ?? "";
    return {
        read,
        update: (change) =>
            queueOnFile(path, async () => {
                const current = await read();
                const updated = change(current);
                if (updated === undefined) {
                    return current;
                }
                await writeFileAtomic(path, updated, mode);
                return updated;
            }),
    };
};

export interface EnsureLinesOptions {
    // A comment written once above the lines appended, for the person who later reads the file and wonders who wrote
    // them; left out when the file already holds it, and never written alone.
    readonly note?: string;
}

// Appends each of `lines` the file lacks, through `update`, so a second call is a no-op and two callers growing one
// shared file (a repo's `info/exclude`, read by every worktree) never drop each other's lines. What the file holds is
// kept byte for byte; a newline goes in first when it does not end with one. Lines compare trimmed, so a CRLF file or an
// indented copy counts as having the line. A missing file is created, its directory with it.
export const ensureLines = async (path: string, lines: readonly string[], options: EnsureLinesOptions = {}): Promise<void> => {
    await textFile(path).update((current) => {
        const held = new Set(current.split("\n").map((line) => line.trim()));
        const missing = [...new Set(lines)].filter((line) => !held.has(line.trim()));
        if (missing.length === 0) {
            return undefined;
        }
        const note = options.note === undefined || held.has(options.note.trim()) ? [] : [options.note];
        const separator = current === "" || current.endsWith("\n") ? "" : "\n";
        return `${current}${separator}${[...note, ...missing].join("\n")}\n`;
    });
};
