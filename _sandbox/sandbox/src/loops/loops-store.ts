import {
    type Loop,
    type LoopDesign,
    LoopDesignSchema,
    type LoopIteration,
    type LoopRecord,
    LoopRecordSchema,
    type LoopState,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* The loop manifest (<workspace>/.intentic/records/loops.json): every loop this workspace has run, with its iteration
 * history. Mirrors the automations store, down to the read-modify-write-through-jsonFile shape.
 *
 * KEYED BY CONVERSATION, because that is what a loop is, one conversation, driven repeatedly. A conversation
 * that is looped twice keeps ONE record and the second run replaces the first: the alternative is a growing list
 * of near-identical rows whose only distinguishing feature is a start time nobody reads, and the history a user
 * actually wants ("what did the loop on this agent do") is the current one.
 *
 * KEPT AFTER THE LOOP ENDS, unlike the turn journal beside it. A finished loop is not debris, it is the answer
 * to "why did this stop at iteration 4", and that answer is its iteration list. Bounded by RECORDS_KEPT rather
 * than by a lifetime, because a loop is a deliberate act (a person, or a workflow, started it) and there are
 * never many.
 */

// How many loops the manifest remembers, newest first. Generous, a loop is rare compared to a turn, each
// record is a few hundred bytes, and the whole value of the file is being able to look back at one.
const RECORDS_KEPT = 100;

// How many iterations one record keeps. A loop is capped at 50 iterations by the contract, so this only ever
// binds on a record that was restarted; it exists so a hand-edited manifest cannot grow without limit.
const ITERATIONS_KEPT = 50;

export interface LoopsStore {
    // Newest-started first, the order the list route serves and the UI renders.
    readonly list: () => Promise<LoopRecord[]>;
    readonly get: (conversationId: string) => Promise<LoopRecord | undefined>;
    // Open a loop: replaces any previous record for that conversation and starts its history empty.
    readonly start: (loop: Loop, now: number) => Promise<LoopRecord>;
    // Append one iteration's outcome. A record that vanished underneath (the manifest was hand-edited, the
    // conversation was discarded) drops the write rather than resurrecting it, the same rule recordRun follows.
    readonly recordIteration: (conversationId: string, iteration: LoopIteration) => Promise<void>;
    // Close a loop. `detail` is why, for the states whose reason is not in their name.
    readonly settle: (conversationId: string, state: LoopState, now: number, detail?: string) => Promise<void>;
    // Count one boot-time resume against the record, so a loop whose iteration kills the daemon cannot be
    // resurrected forever. Returns the record as it now stands, or undefined when it went away underneath.
    readonly countResume: (conversationId: string) => Promise<LoopRecord | undefined>;
}

export const fileLoopsStore = (path: string): LoopsStore => {
    const file = jsonFile<LoopRecord[]>(path, {
        parse: (raw) => z.array(LoopRecordSchema).safeParse(raw).data,
        fallback: () => [],
    });
    // Every mutation below is "find this conversation's record, replace it", the find is by conversationId
    // because that is the key, and a record that isn't there is a no-op rather than an error.
    const amend = async (conversationId: string, change: (record: LoopRecord) => LoopRecord): Promise<void> => {
        await file.update((records) => {
            const existing = records.find((record) => record.conversationId === conversationId);
            return existing === undefined ? records : records.map((record) => (record === existing ? change(existing) : record));
        });
    };
    return {
        list: async () => (await file.read()).toSorted((a, b) => b.startedAt - a.startedAt),
        get: async (conversationId) => (await file.read()).find((record) => record.conversationId === conversationId),
        start: async (loop, now) => {
            const record: LoopRecord = { ...loop, state: "running", startedAt: now, resumed: 0, iterations: [] };
            await file.update((records) =>
                [record, ...records.filter((entry) => entry.conversationId !== loop.conversationId)].slice(0, RECORDS_KEPT),
            );
            return record;
        },
        recordIteration: (conversationId, iteration) =>
            amend(conversationId, (record) => ({ ...record, iterations: [...record.iterations, iteration].slice(-ITERATIONS_KEPT) })),
        settle: (conversationId, state, now, detail) =>
            amend(conversationId, (record) => ({ ...record, state, endedAt: now, ...(detail !== undefined ? { detail } : {}) })),
        countResume: async (conversationId) => {
            await amend(conversationId, (record) => ({ ...record, resumed: record.resumed + 1 }));
            return (await file.read()).find((record) => record.conversationId === conversationId);
        },
    };
};

/* THE SECOND FILE (<workspace>/.intentic/config/loop-designs.json): the loops a user has SAVED, which is a manifest and
 * not a ledger. It shares this module with the record store above and nothing else, the split is the one
 * workflows-store.ts draws for the same reason. A manifest is a handful of entries authored by a person and
 * changing at human speed; a ledger is written several times per iteration by a pump. Keeping them apart is
 * what stops a loop's fourth iteration write from rewriting the designs the user is editing in another tab.
 *
 * Unbounded, unlike the records: there is no machine here writing entries, so the only thing that can grow the
 * file is somebody deciding they want another saved loop.
 */
export interface LoopDesignsStore {
    readonly list: () => Promise<LoopDesign[]>;
    readonly get: (id: string) => Promise<LoopDesign | undefined>;
    // Atomic create-or-update with the caller's intent explicit, a create never overwrites, an update never
    // invents. The same collision guard a workflow save keeps, and for the same reason: these ids are minted
    // from names, so two loops called "until tests pass" would collide in the ordinary course of use.
    readonly save: (design: LoopDesign, create: boolean) => Promise<"saved" | "conflict" | "missing">;
    readonly remove: (id: string) => Promise<boolean>;
}

export const fileLoopDesignsStore = (path: string): LoopDesignsStore => {
    const file = jsonFile<LoopDesign[]>(path, {
        parse: (raw) => z.array(LoopDesignSchema).safeParse(raw).data,
        fallback: () => [],
    });
    return {
        list: () => file.read(),
        get: async (id) => (await file.read()).find((design) => design.id === id),
        save: async (design, create) => {
            let outcome: "saved" | "conflict" | "missing" = "saved";
            await file.update((designs) => {
                const index = designs.findIndex((entry) => entry.id === design.id);
                if (create && index !== -1) {
                    outcome = "conflict";
                    return designs;
                }
                if (!create && index === -1) {
                    outcome = "missing";
                    return designs;
                }
                return create ? [...designs, design] : designs.map((entry, at) => (at === index ? design : entry));
            });
            return outcome;
        },
        remove: async (id) => {
            const before = (await file.read()).length;
            const after = await file.update((designs) => designs.filter((design) => design.id !== id));
            return after.length < before;
        },
    };
};
