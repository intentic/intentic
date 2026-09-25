import { readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode, errorMessage, isMissing, undefinedIfMissing } from "@intentic/base/errors";
import { queueOnFile } from "@intentic/base/fs";
import { readDocument } from "@intentic/sandbox-contract/documents";
import { CHECK_SETTLES } from "./evolution/conversions.js";
import type { DocumentSpec } from "./evolution/documents.js";
import { asideOf, ManifestUnreadableError, writeJsonFile } from "./json-file.js";
import { newerBuildRan } from "./newest-run.js";

// Directory of one JSON file per entry, for a store with a second writer besides the daemon; jsonFile is the
// single-manifest shape for a daemon-only writer.
// - the id is the filename, stripped from the body on write and grafted back on read, so the two can never disagree
// - an unparsable filename is reported by list(), never silently dropped
// - the document's conversions run over each file before `parse`, and a write keeps what the file it replaces held
//   that this build does not know (passthrough.ts), so a rollback's older build edits around a newer one's keys
// - a write over an entry this build cannot read follows jsonFile's policy: the bytes move aside first
//   (`<id>.json.corrupt`), and after a newer build has run here the write is refused instead

// Charset must mirror `entryId` in sandbox-contract's schemas/internal.ts.
const ENTRY_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/;

export interface JsonDir<T> {
    // The entry, or undefined when absent or not a valid id; throws ManifestUnreadableError for an entry that exists
    // but this build cannot read, so no caller mistakes it for absent and writes a fresh one over it.
    readonly read: (id: string) => Promise<(T & { id: string }) | undefined>;
    // All entries, unordered, plus filenames that failed to parse; a missing directory reads as empty, not an error.
    readonly list: () => Promise<{ entries: (T & { id: string })[]; invalid: string[] }>;
    // Upsert, replacing an existing id whole; atomic, so a concurrent list() never sees a partial write.
    readonly write: (id: string, body: T) => Promise<void>;
    // True when an entry of that id existed and was removed.
    readonly remove: (id: string) => Promise<boolean>;
    // Moves an entry this build cannot read aside (`<id>.json.corrupt`), out of `list`, where a hand can still recover it.
    readonly setAside: (id: string) => Promise<void>;
}

export const jsonDir = <T>(dir: string, parse: (raw: unknown) => T | undefined, document?: DocumentSpec): JsonDir<T> => {
    const entryPath = (id: string): string => join(dir, `${id}.json`);
    // Raw JSON as today's shape: the document's conversions, when it has any, before any schema sees it.
    // Each file one document, so its conversions apply to the file as a whole.
    const shape = { history: document?.history ?? [], granularity: "object" } as const;

    // One entry as it stands: absent, read (the raw JSON as today's shape and what parse made of it, for a write to
    // carry forward), or there and unreadable, with what was wrong.
    type Loaded =
        | { readonly kind: "absent" }
        | { readonly kind: "read"; readonly parsed: T; readonly carry: (updated: T) => unknown }
        | { readonly kind: "unreadable"; readonly detail: string };
    const load = async (path: string): Promise<Loaded> => {
        let text: string | undefined;
        try {
            text = await readFile(path, "utf8").catch(undefinedIfMissing);
        } catch (error) {
            return { kind: "unreadable", detail: `the file could not be read (${errnoCode(error) ?? errorMessage(error)})` };
        }
        if (text === undefined) {
            return { kind: "absent" };
        }
        const read = readDocument<T>(text, shape, { kind: "whole", parse: (raw) => parse(raw) }, CHECK_SETTLES);
        return read.value === undefined
            ? { kind: "unreadable", detail: read.problems[0]?.detail ?? "the file does not match what this build expects" }
            : { kind: "read", parsed: read.value, carry: read.carry };
    };

    const read = async (id: string): Promise<(T & { id: string }) | undefined> => {
        if (!ENTRY_ID.test(id)) {
            return undefined;
        }
        const path = entryPath(id);
        const loaded = await load(path);
        if (loaded.kind === "unreadable") {
            throw new ManifestUnreadableError(path, loaded.detail);
        }
        return loaded.kind === "absent" ? undefined : { ...loaded.parsed, id };
    };

    return {
        read,
        list: async () => {
            const names = (await readdir(dir).catch(undefinedIfMissing)) ?? [];
            const entries: (T & { id: string })[] = [];
            const invalid: string[] = [];
            // Filters to `.json` so an in-progress `.<id>.json.<pid>.<n>.tmp` write is never read as a malformed entry.
            for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
                const id = name.slice(0, -".json".length);
                if (!ENTRY_ID.test(id)) {
                    invalid.push(name);
                    continue;
                }
                let entry: (T & { id: string }) | undefined;
                try {
                    entry = await read(id);
                } catch (error) {
                    if (!(error instanceof ManifestUnreadableError)) {
                        throw error;
                    }
                    invalid.push(name);
                    continue;
                }
                // Undefined here is an entry removed between the listing and the read.
                if (entry !== undefined) {
                    entries.push(entry);
                }
            }
            return { entries, invalid };
        },
        // Serialized per entry, since carrying forward reads the file this write replaces.
        write: (id, body) =>
            queueOnFile(entryPath(id), async () => {
                const path = entryPath(id);
                const before = await load(path);
                if (before.kind === "unreadable") {
                    // Never written over: a newer build's entry is refused (setting it aside would hand the owner a reset
                    // the moment they roll forward), anything else is moved aside where a hand can recover it.
                    if (newerBuildRan()) {
                        throw new ManifestUnreadableError(path, `${before.detail}; a newer intentic wrote it`);
                    }
                    await rename(path, await asideOf(path)).catch(undefinedIfMissing);
                }
                await writeJsonFile(path, before.kind === "read" ? before.carry(body) : body);
            }),
        remove: (id) =>
            unlink(entryPath(id)).then(
                () => true,
                (error: unknown) => {
                    if (isMissing(error)) {
                        return false;
                    }
                    throw error;
                },
            ),
        setAside: async (id) => rename(entryPath(id), await asideOf(entryPath(id))),
    };
};
