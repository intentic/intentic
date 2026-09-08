import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type ManifestProblem, recordManifestProblems } from "./manifest-problems.js";
import { type ManifestEdit, registerManifestEditor } from "./manifest-repair.js";

// One JSON file, read through a schema and written whole; every `*-store.ts` in the daemon sits on this.
// - atomicity: writes go to a sibling temp file and rename over the target, so a reader never sees a half-written file
// - lost updates: `update` serializes read-modify-write through a per-file queue
// - downgrades: an update that would overwrite content this build could not read renames it aside first
//   (`<name>.corrupt`)
// - silence: every read reports its outcome to the manifest-problems registry, so a clean read clears a prior complaint

export interface JsonFile<T> {
    // Contents, or the fallback if unreadable; not queued, since a write is never observable half-done.
    readonly read: () => Promise<T>;
    // Read-change-write, serialized against every other update of this file, and returns what was written. Returning
    // `current` unchanged by reference skips the write, so read-or-init is free once already initialized.
    readonly update: (change: (current: T) => T) => Promise<T>;
}

export interface JsonFileOptions<T> {
    // Parsed value, or undefined to select the fallback; `report` flags a problem within an otherwise valid parse.
    readonly parse: (raw: unknown, report: (problem: ManifestProblem) => void) => T | undefined;
    // Value used when absent, unreadable, or rejected; a function so callers never share one mutable instance.
    readonly fallback: () => T;
    // File mode for the write; omitted, it defaults to the process umask like every other manifest.
    readonly mode?: number;
}

// Writes one JSON file atomically (temp file, then rename); used by jsonFile and by stores that must own their own read
// path.
export const writeJsonFile = async (path: string, value: unknown, mode?: number): Promise<void> => {
    // Sibling, pid-tagged temp path; leading dot avoids prefix-matching the target in the watcher's path table.
    const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(value, undefined, 2)}\n`, mode === undefined ? undefined : { mode });
    await rename(tempPath, path);
};

export const jsonFile = <T>(path: string, { parse, fallback, mode }: JsonFileOptions<T>): JsonFile<T> => {
    // Value plus whether it stands in for content that exists but couldn't be read; only `update` acts on that
    // distinction, a plain read answers the same either way.
    const readState = async (): Promise<{ value: T; unreadable: boolean }> => {
        // Recorded on every read, including clean ones, so the registry self-clears when a complaint no longer applies.
        const problems: ManifestProblem[] = [];
        const done = <R extends { value: T; unreadable: boolean }>(state: R): R => {
            recordManifestProblems(path, problems);
            return state;
        };
        let text: string;
        try {
            text = await readFile(path, "utf8");
        } catch {
            return done({ value: fallback(), unreadable: false });
        }
        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch {
            problems.push({ kind: "unreadable", detail: "the file is not valid JSON" });
            return done({ value: fallback(), unreadable: true });
        }
        const parsed = parse(raw, (problem) => problems.push(problem));
        if (parsed === undefined) {
            // Schema-rejected: the file's content is ignored in favor of defaults, with no other way to notice.
            problems.push({ kind: "unreadable", detail: "the file does not match what this build expects" });
            return done({ value: fallback(), unreadable: true });
        }
        return done({ value: parsed, unreadable: false });
    };

    // The chain doubles as the write queue; a failed update still settles it so the next update runs.
    let queue: Promise<unknown> = Promise.resolve();

    // Edits the raw JSON on the same queue as update, for removing a key `parse` already drops before `update` ever
    // sees it.
    // Writes nothing if the edit returns undefined, and never touches a file it could not parse.
    const editRaw = (edit: ManifestEdit): Promise<boolean> => {
        const next = queue.then(async () => {
            let raw: unknown;
            try {
                raw = JSON.parse(await readFile(path, "utf8"));
            } catch {
                // Absent or not JSON: nothing to remove, and overwriting unreadable content would be the downgrade this
                // avoids.
                return false;
            }
            if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
                return false;
            }
            const updated = edit(raw as Record<string, unknown>);
            if (updated === undefined) {
                return false;
            }
            await writeJsonFile(path, updated, mode);
            return true;
        });
        queue = next.catch(() => undefined);
        return next;
    };

    // Registered here so a manifest is never reportable without also being repairable.
    registerManifestEditor(path, editRaw);

    return {
        read: async () => (await readState()).value,
        update: (change) => {
            const next = queue.then(async () => {
                const { value: current, unreadable } = await readState();
                const updated = change(current);
                if (updated !== current) {
                    // Unreadable content moves aside instead of being overwritten, recoverable by hand or by a later
                    // roll-forward.
                    if (unreadable) {
                        await rename(path, `${path}.corrupt`).catch(() => undefined);
                    }
                    await writeJsonFile(path, updated, mode);
                }
                return updated;
            });
            queue = next.catch(() => undefined);
            return next;
        },
    };
};
