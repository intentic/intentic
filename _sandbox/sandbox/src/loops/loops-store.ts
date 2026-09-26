import {
    type Loop,
    type LoopDesign,
    LoopDesignSchema,
    type LoopIteration,
    type LoopRecord,
    LoopRecordSchema,
    type LoopState,
} from "@intentic/sandbox-contract";
import { defineDocument } from "../store/evolution/documents.js";
import { openEntries } from "../store/open-document.js";
import { countResume, keyedEntries } from "../store/keyed-entries.js";
import { stateRelPath } from "../state-paths.js";

// Loop manifest (<workspace>/.intentic/records/loops.json): every loop run, with its iteration history; mirrors the
// automations store's shape. Keyed by conversation, so re-running replaces rather than duplicates the prior record.
// Kept after the loop ends, bounded by RECORDS_KEPT rather than time.

// How many loops the manifest remembers, newest first; generous since loops are rare and small.
const RECORDS_KEPT = 100;

// Iterations kept per record; only binds on a restarted record, since the contract caps a loop at 50 anyway.
const ITERATIONS_KEPT = 50;

export interface LoopsStore {
    // Newest-started first, the order the list route serves and the UI renders.
    readonly list: () => Promise<LoopRecord[]>;
    readonly get: (conversationId: string) => Promise<LoopRecord | undefined>;
    // Open a loop: replaces any previous record for that conversation and starts its history empty.
    readonly start: (loop: Loop, now: number) => Promise<LoopRecord>;
    // Appends one iteration; a vanished record (hand-edited manifest, discarded chat) drops the write silently.
    readonly recordIteration: (conversationId: string, iteration: LoopIteration) => Promise<void>;
    // Close a loop. `detail` is why, for the states whose reason is not in their name.
    readonly settle: (conversationId: string, state: LoopState, now: number, detail?: string) => Promise<void>;
    // Counts a boot resume so a daemon-killing loop isn't resurrected forever; undefined once the record is gone.
    readonly countResume: (conversationId: string) => Promise<LoopRecord | undefined>;
}

export const loopsDocument = defineDocument({ path: stateRelPath(".intentic/records/loops.json"), schema: LoopRecordSchema, granularity: "entries" });
export const loopDesignsDocument = defineDocument({ path: stateRelPath(".intentic/config/loop-designs.json"), schema: LoopDesignSchema, granularity: "entries" });

export const fileLoopsStore = (path: string): LoopsStore => {
    const file = openEntries(loopsDocument, path, { idKeys: ["conversationId"] });
    const keyed = keyedEntries(file, "conversationId");
    return {
        list: async () => (await file.read()).toSorted((a, b) => b.startedAt - a.startedAt),
        get: keyed.get,
        start: async (loop, now) => {
            const record: LoopRecord = { ...loop, state: "running", startedAt: now, resumed: 0, iterations: [] };
            await file.update((records) =>
                [record, ...records.filter((entry) => entry.conversationId !== loop.conversationId)].slice(0, RECORDS_KEPT),
            );
            return record;
        },
        recordIteration: (conversationId, iteration) =>
            keyed.amend(conversationId, (record) => ({ ...record, iterations: [...record.iterations, iteration].slice(-ITERATIONS_KEPT) })),
        settle: (conversationId, state, now, detail) =>
            keyed.amend(conversationId, (record) => ({ ...record, state, endedAt: now, ...(detail !== undefined ? { detail } : {}) })),
        countResume: (conversationId) => countResume(keyed, conversationId),
    };
};

// Saved loop designs (<workspace>/.intentic/config/loop-designs.json): human-edited, kept separate from the iteration
// ledger above so a pump's write never collides with an edit. Unbounded: only a saved design grows it.
export interface LoopDesignsStore {
    readonly list: () => Promise<LoopDesign[]>;
    readonly get: (id: string) => Promise<LoopDesign | undefined>;
    // Create or update, intent explicit: create never overwrites, update never invents; name-minted ids can collide.
    readonly save: (design: LoopDesign, create: boolean) => Promise<"saved" | "conflict" | "missing">;
    readonly remove: (id: string) => Promise<boolean>;
}

export const fileLoopDesignsStore = (path: string): LoopDesignsStore => {
    const file = openEntries(loopDesignsDocument, path);
    const { get, save, remove } = keyedEntries(file, "id");
    return { list: () => file.read(), get, save, remove };
};
