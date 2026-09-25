import type { JsonFile } from "./json-file.js";

// What every store over entries keyed by one string field repeats: the run ledgers, the saved designs.
export interface KeyedEntries<E> {
    readonly get: (key: string) => Promise<E | undefined>;
    // Replaces the one entry under `key`; a missing one is a no-op, since a writer may outlive the record it writes to.
    readonly amend: (key: string, change: (entry: E) => E) => Promise<void>;
    // Create never overwrites and update never invents, since ids minted from names can collide.
    readonly save: (entry: E, create: boolean) => Promise<"saved" | "conflict" | "missing">;
    // True when an entry under `key` existed and is gone.
    readonly remove: (key: string) => Promise<boolean>;
}

export const keyedEntries = <E extends { readonly [K in Key]: string }, Key extends string>(file: JsonFile<E[]>, key: Key): KeyedEntries<E> => {
    const find = (entries: readonly E[], wanted: string): E | undefined => entries.find((entry) => entry[key] === wanted);
    return {
        get: async (wanted) => find(await file.read(), wanted),
        amend: async (wanted, change) => {
            await file.update((entries) => {
                const existing = find(entries, wanted);
                return existing === undefined ? entries : entries.map((entry) => (entry === existing ? change(existing) : entry));
            });
        },
        save: async (saved, create) => {
            let outcome: "saved" | "conflict" | "missing" = "saved";
            await file.update((entries) => {
                const index = entries.findIndex((entry) => entry[key] === saved[key]);
                if (create && index !== -1) {
                    outcome = "conflict";
                    return entries;
                }
                if (!create && index === -1) {
                    outcome = "missing";
                    return entries;
                }
                return create ? [...entries, saved] : entries.map((entry, at) => (at === index ? saved : entry));
            });
            return outcome;
        },
        remove: async (wanted) => {
            let removed = false;
            await file.update((entries) => {
                const kept = entries.filter((entry) => entry[key] !== wanted);
                removed = kept.length !== entries.length;
                return removed ? kept : entries;
            });
            return removed;
        },
    };
};

// Counts a boot resume so a run that keeps killing the daemon isn't resurrected forever; undefined once it is gone.
export const countResume = async <E extends { readonly resumed: number }>(
    entries: Pick<KeyedEntries<E>, "amend" | "get">,
    key: string,
): Promise<E | undefined> => {
    await entries.amend(key, (entry) => ({ ...entry, resumed: entry.resumed + 1 }));
    return entries.get(key);
};
