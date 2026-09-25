import { lstat, readFile, rename } from "node:fs/promises";
import { basename } from "node:path";
import { errnoCode, isMissing, undefinedIfMissing } from "@intentic/base/errors";
import { queueOnFile, writeFileAtomic } from "@intentic/base/fs";
import { type DocumentParse, readDocument } from "@intentic/sandbox-contract/documents";
import { CHECK_SETTLES } from "./evolution/conversions.js";
import type { DocumentSpec } from "./evolution/documents.js";
import { type ManifestProblem, recordManifestProblems } from "./manifest-problems.js";
import { type ManifestEdit, registerManifestEditor } from "./manifest-repair.js";
import { newerBuildRan } from "./newest-run.js";
import type { IdKeys } from "./evolution/passthrough.js";

// One JSON file, read through a schema and written whole; every `*-store.ts` in the daemon sits on this.
// - atomicity: writes go to a sibling temp file and rename over the target, so a reader never sees a half-written file
// - lost updates: `update` serializes read-modify-write through a per-path queue every handle on the file shares
// - evolution: a store's document conversions (conversions.ts) run over the raw JSON before the schema on every read,
//   so a file from any earlier build reads as today's shape
// - rollbacks: a write carries forward what this build's parse dropped (passthrough.ts), keys and entries a newer build
//   wrote, instead of deleting them on the first save
// - downgrades: an update over content this build could not read sets it aside first (`<name>.corrupt`), or refuses
//   outright when the file is one the owner maintains (`onUnreadable`) or a newer build has run this workspace
// - silence: every read reports its outcome to the manifest-problems registry, so a clean read clears a prior complaint

export interface JsonFile<T> {
    // Contents, or the fallback if unreadable; not queued, since a write is never observable half-done.
    readonly read: () => Promise<T>;
    // The same read, plus whether the value stands in for content that exists but this build could not read.
    readonly state: () => Promise<JsonFileState<T>>;
    // Read-change-write, serialized against every other update of this file, and returns what was written. Returning
    // `current` unchanged by reference skips the write, so read-or-init is free once already initialized.
    readonly update: (change: (current: T) => T) => Promise<T>;
}

export type JsonFileState<T> =
    | { readonly value: T; readonly unreadable: false }
    | { readonly value: T; readonly unreadable: true; readonly detail: string };

// Thrown by `update` under `onUnreadable: "refuse"`; names the file and what was wrong with it, for the owner to fix.
export class ManifestUnreadableError extends Error {
    constructor(path: string, detail: string) {
        super(`${basename(path)} could not be read by this build (${detail}); fix or remove the file before anything can be written to it`);
        this.name = "ManifestUnreadableError";
    }
}

type Report = (problem: ManifestProblem) => void;

export interface JsonFileOptions<T> {
    // Parsed value, or undefined to select the fallback; `report` flags a problem within an otherwise valid parse.
    readonly parse: (raw: unknown, report: Report) => T | undefined;
    // Value used when absent, unreadable, or rejected; a function so callers never share one mutable instance.
    readonly fallback: () => T;
    // File mode for the write; omitted, it defaults to the process umask like every other manifest.
    readonly mode?: number;
    // What `update` does over content this build could not read: set it aside as `<name>.corrupt` and write (state the
    // daemon can regrow), or refuse (a manifest the owner maintains, which nothing may replace for them).
    readonly onUnreadable?: "setAside" | "refuse";
    // The document this file holds, whose conversions run over the raw JSON before `parse`.
    readonly document?: DocumentSpec;
}

// What `jsonEntries` needs instead of a whole-file parse: how to read one entry, undefined for one this build cannot.
export interface JsonEntriesOptions<E> extends Omit<JsonFileOptions<E[]>, "parse" | "fallback"> {
    readonly entry: (raw: unknown, report: Report) => E | undefined;
    // The keys that name an entry, for pairing a rebuilt entry with the one it replaces; `id` unless the entries use
    // another (a workflow run's `runId`).
    readonly idKeys?: IdKeys;
}

// Where unreadable content is set aside: `<name>.corrupt`, or a stamped sibling when an earlier episode already holds
// that name, since neither copy is regrowable.
export const asideOf = async (path: string): Promise<string> =>
    (await lstat(`${path}.corrupt`).catch(undefinedIfMissing)) === undefined ? `${path}.corrupt` : `${path}.corrupt.${Date.now()}`;

// Writes one JSON file atomically (temp file, then rename); used by jsonFile and by stores that must own their own read
// path.
export const writeJsonFile = (path: string, value: unknown, mode?: number): Promise<void> =>
    writeFileAtomic(path, `${JSON.stringify(value, undefined, 2)}\n`, mode);

interface Read<T> {
    readonly state: JsonFileState<T>;
    // Present only for a readable file: the bytes a change to its value writes.
    readonly carry?: (updated: T) => unknown;
}

interface Store<T> {
    // How the file reads (@intentic/sandbox-contract/documents, readDocument): whole, or one entry at a time.
    readonly how: DocumentParse<T>;
    readonly fallback: () => T;
    readonly mode: number | undefined;
    readonly onUnreadable: "setAside" | "refuse";
    readonly document: DocumentSpec | undefined;
}

// A file with no document has no conversions to run.
const NO_HISTORY = { history: [], granularity: "object" } as const;

const openJsonFile = <T>(path: string, store: Store<T>): JsonFile<T> => {
    const { how, fallback, mode, onUnreadable, document } = store;
    // Value plus whether it stands in for content that exists but couldn't be read; a plain read answers the same
    // either way.
    const readState = async (): Promise<Read<T>> => {
        // Recorded on every read, including clean ones, so the registry self-clears when a complaint no longer applies.
        const problems: ManifestProblem[] = [];
        const done = (read: Read<T>): Read<T> => {
            recordManifestProblems(path, problems);
            return read;
        };
        const unreadable = (detail: string): Read<T> => {
            problems.push({ kind: "unreadable", reason: "io", detail });
            return done({ state: { value: fallback(), unreadable: true, detail } });
        };
        let text: string;
        try {
            text = await readFile(path, "utf8");
        } catch (error) {
            // Only absence is "nothing written yet"; a file that exists but cannot be read must never be written over.
            if (isMissing(error)) {
                return done({ state: { value: fallback(), unreadable: false } });
            }
            return unreadable(`the file could not be read (${errnoCode(error) ?? String(error)})`);
        }
        const read = readDocument(text, document ?? NO_HISTORY, how, CHECK_SETTLES);
        problems.push(...read.problems);
        if (read.value === undefined) {
            const detail = read.problems[0]?.detail ?? "the file does not match what this build expects";
            return done({ state: { value: fallback(), unreadable: true, detail } });
        }
        return done({ state: { value: read.value, unreadable: false }, carry: read.carry });
    };

    // Edits the raw JSON on the same queue as update, for removing a key `parse` already drops before `update` ever
    // sees it.
    // Writes nothing if the edit returns undefined, and never touches a file it could not parse.
    const editRaw = (edit: ManifestEdit): Promise<boolean> =>
        queueOnFile(path, async () => {
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

    // Registered here so a manifest is never reportable without also being repairable.
    registerManifestEditor(path, editRaw);

    return {
        read: async () => (await readState()).state.value,
        state: async () => (await readState()).state,
        update: (change) =>
            queueOnFile(path, async () => {
                const { state, carry } = await readState();
                const updated = change(state.value);
                if (updated === state.value) {
                    return updated;
                }
                if (carry !== undefined) {
                    await writeJsonFile(path, carry(updated), mode);
                    return updated;
                }
                // Content this build could not read is never overwritten: refused, or set aside where a later
                // roll-forward or a hand can recover it. A newer build's file is always refused, since setting it aside
                // would hand the owner a reset the moment they roll forward again.
                if (state.unreadable) {
                    if (onUnreadable === "refuse" || newerBuildRan()) {
                        throw new ManifestUnreadableError(path, newerBuildRan() ? `${state.detail}; a newer intentic wrote it` : state.detail);
                    }
                    await rename(path, await asideOf(path)).catch(undefinedIfMissing);
                }
                await writeJsonFile(path, updated, mode);
                return updated;
            }),
    };
};

export const jsonFile = <T>(path: string, { parse, fallback, mode, onUnreadable = "setAside", document }: JsonFileOptions<T>): JsonFile<T> =>
    openJsonFile(path, {
        how: { kind: "whole", parse },
        fallback,
        mode,
        onUnreadable,
        document,
    });

// A top-level array read one entry at a time: an entry this build cannot read, or whose conversion fails, is reported
// and skipped instead of sinking the whole file to its fallback, and kept in the file on the next write where a later
// build can read it.
export const jsonEntries = <E>(path: string, { entry, mode, onUnreadable = "setAside", document, idKeys = ["id"] }: JsonEntriesOptions<E>): JsonFile<E[]> =>
    openJsonFile<E[]>(path, {
        how: { kind: "entries", entry, idKeys },
        fallback: () => [],
        mode,
        onUnreadable,
        document,
    });

// A newest-last log kept to its `cap` newest entries, over its store's own file, whose shape, mode and refusal stay the store's.
export interface BoundedLog<E> {
    readonly append: (entry: E) => Promise<void>;
    // Rewrites every entry `match` picks; the file is rewritten even when none does.
    readonly amend: (match: (entry: E) => boolean, patch: (entry: E) => E) => Promise<void>;
    // Oldest first, as the file holds them.
    readonly read: () => Promise<E[]>;
}

export const boundedLog = <E>(file: JsonFile<E[]>, cap: number): BoundedLog<E> => ({
    append: async (entry) => {
        await file.update((entries) => [...entries, entry].slice(-cap));
    },
    amend: async (match, patch) => {
        await file.update((entries) => entries.map((entry) => (match(entry) ? patch(entry) : entry)));
    },
    read: () => file.read(),
});

// The owner's yes to what an agent can write, one pin per key, kept under the history root where no workspace write reaches.
export interface ApprovalLedger<P> {
    // An unreadable ledger approves nothing: its pins read as none, and `unreadable` says why.
    readonly read: () => Promise<{ readonly approved: Readonly<Record<string, P>>; readonly unreadable: boolean }>;
    // A change that returns the pins it was handed writes nothing.
    readonly update: (change: (approved: Readonly<Record<string, P>>) => Readonly<Record<string, P>>) => Promise<void>;
}

type Pins<P> = { readonly approved: Readonly<Record<string, P>> };

// One handle per ledger file, so every writer of it shares its update queue.
export const approvalLedgers = <P>(parse: (raw: unknown) => Pins<P> | undefined, document: DocumentSpec): ((path: string) => ApprovalLedger<P>) => {
    const files = new Map<string, JsonFile<Pins<P>>>();
    return (path) => {
        const file = files.get(path) ?? jsonFile<Pins<P>>(path, { parse, fallback: () => ({ approved: {} }), document });
        files.set(path, file);
        return {
            read: async () => {
                const ledger = await file.state();
                return ledger.unreadable ? { approved: {}, unreadable: true } : { approved: ledger.value.approved, unreadable: false };
            },
            update: async (change) => {
                await file.update((ledger) => {
                    const approved = change(ledger.approved);
                    return approved === ledger.approved ? ledger : { approved };
                });
            },
        };
    };
};
