import { lstat, readFile, rename } from "node:fs/promises";
import { basename } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { queueOnFile, writeFileAtomic } from "@intentic/base/fs";
import { type DocumentParse, type DocumentRead, readDocument } from "@intentic/sandbox-contract/documents";
import { CHECK_SETTLES } from "./evolution/conversions.js";
import type { DocumentSpec } from "./evolution/documents.js";
import { type ManifestProblem, recordManifestProblems } from "./manifest/manifest-problems.js";
import { type ManifestEdit, registerManifestEditor } from "./manifest/manifest-repair.js";
import { newerBuildRan } from "./newest-run.js";
import type { IdKeys } from "./evolution/passthrough.js";
import { AT_REST_KEY_FILE_ENV } from "@intentic/sandbox-contract/schemas/data-protection";
import { AT_REST_PREVIOUS_KEY_FILE_ENV, AtRestKeyError, decryptAtRest, encryptAtRest } from "./encryption/at-rest.js";
import { deepFreeze, heldAfterWrite, type MemoCell, readThrough } from "./memo/file-memo.js";

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
// - memo: a handle holds what its file last read as while the file provably has not changed (memo/file-memo.ts), so an
//   unchanged file is read, converted and parsed once; its own writes refill it. What a read or an update is handed is
//   that held value, frozen: a reader that wants to change it builds a new one, as `update` already requires

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
    readonly atRestPurpose?: string;
}

// What `jsonEntries` needs instead of a whole-file parse: how to read one entry, undefined for one this build cannot.
export interface JsonEntriesOptions<E> extends Omit<JsonFileOptions<E[]>, "parse" | "fallback"> {
    readonly entry: (raw: unknown, report: Report) => E | undefined;
    // The keys that name an entry, for pairing a rebuilt entry with the one it replaces; `id` unless the entries use
    // another (a workflow run's `runId`).
    readonly idKeys?: IdKeys;
    // The list read whole or not at all: an entry this build cannot read makes the file unreadable rather than being
    // skipped and written back as it stands, for a list where carrying an entry forward unseen is unsafe.
    readonly strict?: boolean;
}

// Where unreadable content is set aside: `<name>.corrupt`, or a stamped sibling when an earlier episode already holds
// that name, since neither copy is regrowable.
export const asideOf = async (path: string): Promise<string> =>
    (await lstat(`${path}.corrupt`).catch(undefinedIfMissing)) === undefined ? `${path}.corrupt` : `${path}.corrupt.${Date.now()}`;

// Whatever JSON.stringify takes: a store's own value, or the bytes passthrough carried for it.
type JsonValueOf = Parameters<typeof JSON.stringify>[0];

// Writes one JSON file atomically (temp file, then rename); used by jsonFile and by stores that must own their own read
// path. `durable` flushes it to the disk first, for the files nothing may replace (the owner's, `onUnreadable:
// "refuse"`) and the conversion journal: a power cut must not leave any of them an empty name.
export const writeJsonFile = async (path: string, value: unknown, mode?: number, durable = false, atRestPurpose?: string): Promise<void> =>
    writeFileAtomic(path, await jsonBytes(value, atRestPurpose), mode, { durable });

// The bytes a JSON file holds for `value`: pretty-printed, and sealed when it is kept encrypted at rest.
const jsonBytes = async (value: JsonValueOf, atRestPurpose: string | undefined): Promise<string> =>
    atRestPurpose === undefined ? `${JSON.stringify(value, undefined, 2)}\n` : await encryptAtRest(`${JSON.stringify(value, undefined, 2)}\n`, atRestPurpose);

interface Read<T> {
    readonly state: JsonFileState<T>;
    // Present only for a readable file: the bytes a change to its value writes.
    readonly carry?: DocumentRead<T>["carry"] | undefined;
}

// What one set of bytes read as: the value with what a change to it writes, or why it is unreadable; and the problems
// to record either way. Held by the memo, so a read of an unchanged file records the same problems without a parse.
type Reading<T> = { readonly problems: readonly ManifestProblem[] } & (
    | { readonly value: T; readonly carry?: DocumentRead<T>["carry"]; readonly unreadable?: undefined }
    | { readonly unreadable: string }
);

interface Store<T> {
    // How the file reads (@intentic/sandbox-contract/documents, readDocument): whole, or one entry at a time.
    readonly how: DocumentParse<T>;
    readonly fallback: () => T;
    readonly mode: number | undefined;
    readonly onUnreadable: "setAside" | "refuse";
    readonly document: DocumentSpec | undefined;
    readonly strict: boolean;
    readonly atRestPurpose: string | undefined;
}

// Which at-rest key files are configured now, current and previous.
const atRestKeys = (): string => `${process.env[AT_REST_KEY_FILE_ENV] ?? ""}\u0000${process.env[AT_REST_PREVIOUS_KEY_FILE_ENV] ?? ""}`;

// A file with no document has no conversions to run.
const NO_HISTORY = { history: [], granularity: "object" } as const;

// What a file's bytes read as, before the fallback stands in: decrypted, converted, parsed, and judged.
const interpreter =
    <T>(path: string, { how, document, strict, atRestPurpose }: Store<T>) =>
    async (bytes: string): Promise<Reading<T>> => {
        let text = bytes;
        if (atRestPurpose !== undefined) {
            try {
                text = await decryptAtRest(bytes, atRestPurpose);
            } catch (error) {
                if (error instanceof AtRestKeyError) {throw error;}
                throw new AtRestKeyError(`could not decrypt ${path}: ${String(error)}; refusing to replace it`);
            }
        }
        const read = readDocument(text, document ?? NO_HISTORY, how, CHECK_SETTLES);
        if (read.value === undefined) {
            return { problems: read.problems, unreadable: read.problems[0]?.detail ?? "the file does not match what this build expects" };
        }
        if (strict && read.problems.some((problem) => problem.kind === "invalidEntry")) {
            return { problems: read.problems, unreadable: "an entry in it is not one this build can read" };
        }
        // Frozen: the memo hands this one value to every later read and update until the file changes (memo/file-memo.ts).
        return { problems: read.problems, value: deepFreeze(read.value), carry: read.carry };
    };

const ioUnreadable = <T>(reason: string): Reading<T> => {
    const detail = `the file could not be read (${reason})`;
    return { problems: [{ kind: "unreadable", reason: "io", detail }], unreadable: detail };
};

const openJsonFile = <T>(path: string, store: Store<T>): JsonFile<T> => {
    const { fallback, mode, onUnreadable, atRestPurpose } = store;
    const interpret = interpreter(path, store);
    // The last reading and the file identity it was made at; reads skip the file while it stands (memo/file-memo.ts).
    const cell: MemoCell<Reading<T>> = { memo: undefined };
    let sealedUnder = "";
    // Nothing written yet: the fallback, with nothing for a write to carry.
    const absent = (): Reading<T> => ({ problems: [], value: fallback() });

    // Value plus whether it stands in for content that exists but couldn't be read; a plain read answers the same
    // either way. Recorded on every read, including clean ones and memo hits, so the registry self-clears when a
    // complaint no longer applies.
    const readState = async (): Promise<Read<T>> => {
        // A memo of a sealed file holds what the keys named when it was made decrypted it to; other keys must decrypt
        // it again, so a file the new key cannot open is refused as it would have been without the memo.
        const sealing = atRestPurpose === undefined ? "" : atRestKeys();
        if (sealing !== sealedUnder) {
            cell.memo = undefined;
            sealedUnder = sealing;
        }
        // Only absence is "nothing written yet"; a file that exists but cannot be read must never be written over.
        const reading = await readThrough(cell, path, { absent, failed: ioUnreadable<T>, interpret });
        recordManifestProblems(path, reading.problems);
        return reading.unreadable === undefined
            ? { state: { value: reading.value, unreadable: false }, carry: reading.carry }
            : { state: { value: fallback(), unreadable: true, detail: reading.unreadable } };
    };

    // Writes the file whole and holds what it wrote as the memo, so the next read parses nothing it did not have to.
    const write = async (value: JsonValueOf): Promise<void> => {
        cell.memo = undefined;
        const bytes = await jsonBytes(value, atRestPurpose);
        await writeFileAtomic(path, bytes, mode, { durable: onUnreadable === "refuse" });
        await heldAfterWrite(cell, path, bytes, interpret);
    };

    // Edits the raw JSON on the same queue as update, for removing a key `parse` already drops before `update` ever
    // sees it.
    // Writes nothing if the edit returns undefined, and never touches a file it could not parse.
    const editRaw = (edit: ManifestEdit): Promise<boolean> =>
        queueOnFile(path, async () => {
            let raw: unknown;
            try {
                const text = await readFile(path, "utf8");
                raw = JSON.parse(atRestPurpose === undefined ? text : await decryptAtRest(text, atRestPurpose));
            } catch (error) {
                if (error instanceof AtRestKeyError) {throw error;}
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
            // As durable as `update` writes the same file: a repair is no reason to risk an owner's file.
            await writeJsonFile(path, updated, mode, onUnreadable === "refuse", atRestPurpose);
            cell.memo = undefined;
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
                    await write(carry(updated));
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
                await write(updated);
                return updated;
            }),
    };
};

export const jsonFile = <T>(path: string, { parse, fallback, mode, onUnreadable = "setAside", document, atRestPurpose }: JsonFileOptions<T>): JsonFile<T> =>
    openJsonFile(path, {
        how: { kind: "whole", parse },
        fallback,
        mode,
        onUnreadable,
        document,
        strict: false,
        atRestPurpose,
    });

// A top-level array read one entry at a time: an entry this build cannot read, or whose conversion fails, is reported
// and skipped instead of sinking the whole file to its fallback, and kept in the file on the next write where a later
// build can read it.
export const jsonEntries = <E>(path: string, { entry, mode, onUnreadable = "setAside", document, idKeys = ["id"], strict, atRestPurpose }: JsonEntriesOptions<E>): JsonFile<E[]> =>
    openJsonFile<E[]>(path, {
        how: { kind: "entries", entry, idKeys },
        fallback: () => [],
        mode,
        onUnreadable,
        document,
        strict: strict === true,
        atRestPurpose,
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
