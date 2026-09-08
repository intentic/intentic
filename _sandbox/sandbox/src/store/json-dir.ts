import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "./json-file.js";

// Directory of one JSON file per entry, for a store with a second writer besides the daemon; jsonFile is the
// single-manifest shape for a daemon-only writer.
// - the id is the filename, stripped from the body on write and grafted back on read, so the two can never disagree
// - an unparsable filename is reported by list(), never silently dropped

// Charset must mirror `entryId` in sandbox-contract's schemas/internal.ts.
const ENTRY_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/;

export interface JsonDir<T> {
    // The entry, or undefined when it is absent, unreadable, or fails the schema.
    readonly read: (id: string) => Promise<(T & { id: string }) | undefined>;
    // All entries, unordered, plus filenames that failed to parse; a missing directory reads as empty, not an error.
    readonly list: () => Promise<{ entries: (T & { id: string })[]; invalid: string[] }>;
    // Upsert, replacing an existing id whole; atomic, so a concurrent list() never sees a partial write.
    readonly write: (id: string, body: T) => Promise<void>;
    // True when an entry of that id existed and was removed.
    readonly remove: (id: string) => Promise<boolean>;
}

export const jsonDir = <T>(dir: string, parse: (raw: unknown) => T | undefined): JsonDir<T> => {
    const entryPath = (id: string): string => join(dir, `${id}.json`);

    const read = async (id: string): Promise<(T & { id: string }) | undefined> => {
        if (!ENTRY_ID.test(id)) {
            return undefined;
        }
        let raw: unknown;
        try {
            raw = JSON.parse(await readFile(entryPath(id), "utf8"));
        } catch {
            return undefined;
        }
        const body = parse(raw);
        return body === undefined ? undefined : { ...body, id };
    };

    return {
        read,
        list: async () => {
            let names: string[];
            try {
                names = await readdir(dir);
            } catch {
                return { entries: [], invalid: [] };
            }
            const entries: (T & { id: string })[] = [];
            const invalid: string[] = [];
            // Filters to `.json` so an in-progress `.<id>.json.<pid>.tmp` write is never read as a malformed entry.
            for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
                const entry = await read(name.slice(0, -".json".length));
                if (entry === undefined) {
                    invalid.push(name);
                    continue;
                }
                entries.push(entry);
            }
            return { entries, invalid };
        },
        write: (id, body) => writeJsonFile(entryPath(id), body),
        remove: async (id) => {
            try {
                await unlink(entryPath(id));
                return true;
            } catch {
                return false;
            }
        },
    };
};
