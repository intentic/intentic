import type { NeedsFile } from "@intentic/sandbox-contract/schemas/needs";
import { type NeedsStore, needsStoreOver } from "./needs-store.js";

// The needs store held in memory, read and written the way the daemon's file is (needs/needs-store.ts).
export const memoryNeedsStore = (now: () => number = Date.now): NeedsStore => {
    let needs: NeedsFile = {};
    return needsStoreOver(
        {
            read: async () => needs,
            update: async (change) => {
                needs = change(needs);
            },
        },
        now,
    );
};
