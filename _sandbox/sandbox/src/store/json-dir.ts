import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "./json-file.js";

/* The substrate under the daemon's per-entry-file stores, a DIRECTORY holding one JSON file per entry
 * (.intentic/config/drafts/, .intentic/records/approvals/) rather than one manifest holding them all. `jsonFile` is the other
 * shape; this is the one to reach for when the daemon is not the only writer.
 *
 * PER FILE, NEVER A MANIFEST, because both of these have a second writer: the agent creates drafts with its own
 * file tools, and separate automations fire approvals concurrently. Two writers on one manifest race a
 * read-modify-write and the loser's entry is simply gone, `jsonFile`'s update queue orders this daemon's own
 * handlers and nothing else. One file per entry has nothing to race: a write touches only its own id.
 *
 * THE ID IS THE FILENAME and is never in the body, grafted on read, the caller strips it on write. That is
 * what makes a body that disagrees with its own filename impossible to write, and what lets `mv` rename an
 * entry.
 *
 * A NAME THAT IS NOT A VALID ID IS REPORTED, NEVER READ. These directories are a trust boundary, the drafts
 * one is written by the agent, so `list` answers with the entries it parsed AND the filenames it refused,
 * and a typo surfaces in the UI instead of becoming a draft that silently never posts. */

// The contract's `entryId` charset (sandbox-contract's schemas/internal.ts, which the package index does not
// re-export). Held once here rather than re-typed per store: both copies of it carried a comment claiming to
// match this, which is exactly the kind of agreement that drifts unobserved.
const ENTRY_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/;

export interface JsonDir<T> {
    // The entry, or undefined when it is absent, unreadable, or fails the schema.
    readonly read: (id: string) => Promise<(T & { id: string }) | undefined>;
    // Every entry in the directory, unordered (each store sorts by the field its UI reads), plus the filenames
    // that failed. An absent directory is empty, not an error, nothing has been written yet.
    readonly list: () => Promise<{ entries: (T & { id: string })[]; invalid: string[] }>;
    // Upsert: writing an id that exists replaces it whole. Atomic, so a concurrent `list` never sees a prefix.
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
            // Only `.json`, which is also what keeps a write's own `.<id>.json.<pid>.tmp` from being read as a
            // malformed entry while it is mid-swap.
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
