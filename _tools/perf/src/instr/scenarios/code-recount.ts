import { type CountStore, keptLineStat } from "@intentic/code-read/count-cache";
import { grammars } from "@intentic/code-read/grammars";
import { edited, typescriptModule } from "../fixtures.js";
import type { Scenario } from "../scenario.js";

// The daemon's store is SQLite; a Map stands in for it, so what is counted is the key and the lookup, not the disk.
const memoryStore = (): CountStore & { readonly size: () => number } => {
    const rows = new Map<string, { additions: number | null; deletions: number | null }>();
    return {
        get: (key) => rows.get(key),
        put: (key, additions, deletions) => {
            rows.set(key, { additions, deletions });
        },
        size: () => rows.size,
    };
};

export const scenario: Scenario = {
    what: "the counting worker's recount of a pair it counted before (keptLineStat): answered from its store, no grammar walked",
    setup: async () => {
        const before = typescriptModule(1, 40);
        const saved = edited(before);
        const store = memoryStore();
        const first = await keptLineStat(store, before, saved, "src/rows.ts", grammars);
        if (first === undefined || store.size() !== 1) {
            throw new Error(`the first count was not kept: ${JSON.stringify(first)}, ${String(store.size())} rows`);
        }
        return async () => {
            const again = await keptLineStat(store, before, saved, "src/rows.ts", grammars);
            if (again?.additions !== first.additions || again.deletions !== first.deletions || store.size() !== 1) {
                throw new Error(`the recount did not come from the store: ${JSON.stringify(again)}`);
            }
            return again;
        };
    },
};
