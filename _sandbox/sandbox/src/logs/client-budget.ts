// How many browser reports one page load may write per minute, so a tab looping on an error cannot fill
// logs/client.jsonl, whose size cap is otherwise the only backstop (and pruning it throws away every other tab's
// record with it). The browser already folds repeats and caps its own queue (clientDiagnostics.ts); this is for a page
// whose own guard failed, and for a build from before it had one.
//
// Fixed windows per key, plus one shared window over every key, since a page id is the browser's own word and a
// misbehaving one could mint a new id per batch.

export interface ClientBudgetOptions {
    readonly perKeyPerWindow: number;
    readonly allPerWindow: number;
    readonly windowMs: number;
    readonly now?: () => number;
}

interface Slot {
    startedAt: number;
    used: number;
    // Turned away in this window, said once by the next batch that gets through.
    refused: number;
}

// Keys beyond this are swept of windows no longer current, an unsaid refusal with them (a page minting ids is the only
// way to get here, and its count is not worth the memory); a sandbox has a handful of tabs, never hundreds.
const SWEEP_ABOVE = 200;

export interface ClientBudget {
    /** How many of `wanted` reports from `key` may be written now, and how many earlier ones were refused unsaid. */
    take(key: string, wanted: number): { readonly allowed: number; readonly refusedEarlier: number };
}

export const createClientBudget = (options: ClientBudgetOptions): ClientBudget => {
    const now = options.now ?? Date.now;
    const slots = new Map<string, Slot>();
    const all: Slot = { startedAt: Number.NEGATIVE_INFINITY, used: 0, refused: 0 };

    const current = (slot: Slot, at: number): Slot => {
        if (at - slot.startedAt >= options.windowMs) {
            slot.startedAt = at;
            slot.used = 0;
        }
        return slot;
    };

    const sweep = (at: number): void => {
        if (slots.size <= SWEEP_ABOVE) {
            return;
        }
        for (const [key, slot] of slots) {
            if (at - slot.startedAt >= options.windowMs) {
                slots.delete(key);
            }
        }
    };

    return {
        take: (key, wanted) => {
            const at = now();
            const mine = current(slots.get(key) ?? { startedAt: at, used: 0, refused: 0 }, at);
            slots.set(key, mine);
            current(all, at);
            const allowed = Math.max(0, Math.min(wanted, options.perKeyPerWindow - mine.used, options.allPerWindow - all.used));
            mine.used += allowed;
            all.used += allowed;
            const refusedEarlier = allowed > 0 ? mine.refused : 0;
            if (allowed > 0) {
                mine.refused = 0;
            }
            mine.refused += wanted - allowed;
            sweep(at);
            return { allowed, refusedEarlier };
        },
    };
};
