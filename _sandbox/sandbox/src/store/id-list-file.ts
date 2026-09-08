import type { z } from "zod";
import { jsonFile } from "./json-file.js";

// JSON file store for entries keyed by id: an invalid entry is skipped and reported rather than thrown, and writes
// preserve unknown fields so an entry from a newer build survives a rollback.
export interface IdListStore<T> {
    // All entries that validated, in file order.
    readonly list: () => Promise<T[]>;
    readonly get: (id: string) => Promise<T | undefined>;
    // Matches by id; upserting an existing id replaces its entry.
    readonly upsert: (value: T) => Promise<void>;
    // True if an entry with that id existed and was removed.
    readonly remove: (id: string) => Promise<boolean>;
}

// Extracts an entry's id without validating its shape, to key the raw read-modify-write and to name it in warnings.
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
        // Only checks that the value is an array; anything else is treated as empty.
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
                // Returned unchanged by reference when nothing matched, so removing an absent id writes nothing.
                return removed ? next : entries;
            });
            return removed;
        },
    };
};
