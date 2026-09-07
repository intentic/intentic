import type { z } from "zod";
import { jsonFile } from "./json-file.js";

/* A JSON FILE HOLDING A LIST OF THINGS WITH IDS, read per entry so one bad row costs only itself.
 *
 * The two manifests under `.intentic/config` — capabilities.json and personas.json — are the same store with a
 * different schema in it, and they need the same three properties, none of which is obvious:
 *
 *   ONE BAD ENTRY COSTS ITSELF. A hand-edited card must not take every other one down with it, least of all on
 *   the turn path, where the answer decides what an unattended wake is allowed to touch. So entries are
 *   validated one at a time and a failure is skipped, not thrown.
 *
 *   A SKIPPED ENTRY IS REPORTED TWICE, because its two audiences are in different places: `onInvalid` puts it
 *   in the daemon log for whoever is reading logs, and the manifest-problem registry puts it on the screen the
 *   entry vanished from. Until the second existed, "never silent" was only true of the log.
 *
 *   A WRITE PRESERVES WHAT THIS BUILD CANNOT READ. The file is held as the RAW array, so an entry written by a
 *   newer build survives a rollback instead of being quietly dropped by the next edit — which a validated
 *   array could not express. Entries are validated INSIDE `parse`, because that is the only point with a
 *   `report` channel; `read` then validates a second time to produce the typed list. That second pass is over
 *   a file already read off disk and JSON-parsed, and it buys one obvious validation site per concern instead
 *   of a shared one that has to smuggle its findings between the two. */
export interface IdListStore<T> {
    // Every entry, in file order, minus any that did not validate.
    readonly list: () => Promise<T[]>;
    readonly get: (id: string) => Promise<T | undefined>;
    // Upsert by id (re-adding the same id edits the entry).
    readonly upsert: (value: T) => Promise<void>;
    // True when an entry of that id existed and was removed.
    readonly remove: (id: string) => Promise<boolean>;
}

// An entry's id without trusting its shape: enough to key the raw read-modify-write, and to name the entry in
// the warning when it does not validate.
const rawId = (entry: unknown): string | undefined => {
    const id = (entry as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : undefined;
};

export const idListFile = <T extends { readonly id: string }>(
    path: string,
    schema: z.ZodType<T>,
    onInvalid?: (id: string, reason: string) => void,
): IdListStore<T> => {
    const file = jsonFile<unknown[]>(path, {
        // The check here is only "is this a JSON array at all"; anything else reads as empty, which is what a
        // torn file used to read as before jsonFile made torn files unobservable.
        parse: (raw, report) => {
            if (!Array.isArray(raw)) {
                return undefined;
            }
            for (const entry of raw) {
                const parsed = schema.safeParse(entry);
                if (parsed.success) {
                    continue;
                }
                const id = rawId(entry) ?? "<unnamed>";
                const reason = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
                onInvalid?.(id, reason);
                report({ kind: "invalidEntry", detail: `${id}, ${reason}` });
            }
            return raw;
        },
        fallback: () => [],
    });
    const read = async (): Promise<T[]> =>
        (await file.read()).flatMap((entry) => {
            const parsed = schema.safeParse(entry);
            return parsed.success ? [parsed.data] : [];
        });
    return {
        list: read,
        get: async (id) => (await read()).find((entry) => entry.id === id),
        upsert: async (value) => {
            await file.update((entries) => [...entries.filter((entry) => rawId(entry) !== value.id), value]);
        },
        remove: async (id) => {
            let removed = false;
            await file.update((entries) => {
                const next = entries.filter((entry) => rawId(entry) !== id);
                removed = next.length !== entries.length;
                // Unchanged by reference when nothing matched, so a remove of an absent id writes nothing.
                return removed ? next : entries;
            });
            return removed;
        },
    };
};
