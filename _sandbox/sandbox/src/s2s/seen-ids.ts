import { S2S_SEEN_IDS_MS } from "@intentic/sandbox-contract/schemas/s2s";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openLedger } from "../store/open-document.js";

// THE ENVELOPE IDS ALREADY TAKEN (docs/architecture/messages.md, "Receiving", step 2): a retry of an envelope this sandbox
// already stored answers 200 and changes nothing. Each id is remembered 30 days, far past the day an envelope's `sentAt`
// may be behind (admission refuses an older one as a replay), so no id is forgotten while it could still be taken.
//
// A ledger, one line per id taken, read once into memory and appended to after: taking an envelope costs one appended
// line, never a rewrite of every id (2026-11-27). Past its cap the ledger keeps its newest lines, tens of thousands of
// ids, more than a day of any sandbox's traffic at the per-contact minute limits' pace.

export const s2sSeenIdsDocument = defineDocument({
    root: "history",
    path: "s2s/seen-ids.jsonl",
    // Only ids and when they arrived: a moved sandbox still answers a late retry as the duplicate it is.
    portability: "carry",
    granularity: "entries",
    schema: z.object({ id: z.string(), at: z.number().int() }),
});

// When the ledger is cut to its newest lines, and to how many bytes of them (an id's line is about 60 bytes).
const SEEN_IDS_CAP = { overBytes: 8 * 1024 * 1024, keepBytes: 6 * 1024 * 1024 } as const;
// How many ids are taken between two sweeps of the memory for ids past their 30 days.
const SWEEP_EVERY = 1_000;

export interface SeenIds {
    readonly has: (id: string) => Promise<boolean>;
    readonly add: (id: string) => Promise<void>;
}

export const fileSeenIds = (path: string, now: () => number = Date.now): SeenIds => {
    const ledger = openLedger(s2sSeenIdsDocument, path, { cap: SEEN_IDS_CAP });
    let memory: Promise<Map<string, number>> | undefined;
    let added = 0;
    const seen = async (): Promise<Map<string, number>> => {
        memory ??= ledger.read().then((entries) => new Map(entries.map((entry) => [entry.id, entry.at])));
        return memory;
    };
    const kept = (at: number): boolean => now() - at <= S2S_SEEN_IDS_MS;
    return {
        has: async (id) => {
            const at = (await seen()).get(id);
            return at !== undefined && kept(at);
        },
        add: async (id) => {
            const ids = await seen();
            const at = now();
            ids.set(id, at);
            await ledger.append({ id, at });
            added += 1;
            if (added % SWEEP_EVERY === 0) {
                for (const [held, when] of ids) {
                    if (!kept(when)) {
                        ids.delete(held);
                    }
                }
            }
        },
    };
};
