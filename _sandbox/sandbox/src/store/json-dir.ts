import { readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode, errorMessage, isMissing, undefinedIfMissing } from "@intentic/base/errors";
import { convertDocument } from "./conversions.js";
import { type DocumentSpec, documentKey } from "./documents.js";
import { asideOf, ManifestUnreadableError, writeJsonFile } from "./json-file.js";
import { carryUnknown } from "./passthrough.js";
import { reconcileRenames, renameWindowsOf, withOldNames } from "./rename-compat.js";
import { queueOnFile } from "./text-file.js";

// Directory of one JSON file per entry, for a store with a second writer besides the daemon; jsonFile is the
// single-manifest shape for a daemon-only writer.
// - the id is the filename, stripped from the body on write and grafted back on read, so the two can never disagree
// - an unparsable filename is reported by list(), never silently dropped
// - the document's conversions run over each file before `parse`, and a write keeps what the file it replaces held
//   that this build does not know (passthrough.ts), so a rollback's older build edits around a newer one's keys

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
    const perFile = { granularity: "object" } as const;
    const windows = () => (document === undefined ? [] : renameWindowsOf(documentKey(document)));
    const converted = (raw: unknown): unknown =>
        document === undefined ? raw : convertDocument(document.history, "object", reconcileRenames(raw, perFile, windows())).value;

    // The raw entry as it stands and what parse made of it, for a write to carry forward; undefined for an absent or
    // unreadable file, which has nothing this build could carry.
    const current = async (id: string): Promise<{ raw: unknown; parsed: T } | undefined> => {
        try {
            const raw = converted(JSON.parse(await readFile(entryPath(id), "utf8")));
            const parsed = parse(raw);
            return parsed === undefined ? undefined : { raw, parsed };
        } catch {
            // silent-catch: absent, not JSON, or a failed conversion all mean nothing to carry; the write replaces it whole
            return undefined;
        }
    };

    const read = async (id: string): Promise<(T & { id: string }) | undefined> => {
        if (!ENTRY_ID.test(id)) {
            return undefined;
        }
        const path = entryPath(id);
        let text: string | undefined;
        try {
            text = await readFile(path, "utf8").catch(undefinedIfMissing);
        } catch (error) {
            throw new ManifestUnreadableError(path, `the file could not be read (${errnoCode(error) ?? errorMessage(error)})`);
        }
        if (text === undefined) {
            return undefined;
        }
        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch {
            throw new ManifestUnreadableError(path, "the file is not valid JSON");
        }
        try {
            raw = converted(raw);
        } catch (error) {
            throw new ManifestUnreadableError(path, `a conversion to this build's shape failed (${errorMessage(error)})`);
        }
        const body = parse(raw);
        if (body === undefined) {
            throw new ManifestUnreadableError(path, "the file does not match what this build expects");
        }
        return { ...body, id };
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
                const before = await current(id);
                const carried = before === undefined ? body : carryUnknown(before.raw, before.parsed, body);
                await writeJsonFile(entryPath(id), withOldNames(carried, perFile, windows()));
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
