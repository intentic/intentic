// A loop that fails the same way every 30 seconds (a dead GitHub token, an unpaired device knocking) used to write the
// same warn line, stack and all, thousands of times: a third of daemon.log, and the first page of every diagnostics
// read. A gate keeps the first line of each state and lets the rest through only as a count.
//
// `key` names the loop (one per repo, per device); `state` is what it saw (the status, the error's message). A line is
// let through when the state under a key changes, or when `everyMs` has passed since the last one let through, which
// keeps a long outage visible as one line per window. A line that passes carries `repeated`: how many identical ones
// were held back since the previous line for that key, so the count is never lost, only folded.

import { BoundedMap } from "@intentic/base/held";

export interface GateVerdict {
    // Write the line.
    readonly log: boolean;
    // Identical occurrences held back since the last line written for this key; 0 for a first occurrence.
    readonly repeated: number;
}

export interface RepeatGate {
    // Ask before writing a line for `key` in `state`.
    readonly check: (key: string, state: string) => GateVerdict;
    // The loop under `key` is healthy again. Answers what it last saw and how many lines it held back, or undefined
    // when nothing was failing, so the caller writes one "recovered" line only after an outage it reported.
    readonly clear: (key: string) => { readonly state: string; readonly repeated: number } | undefined;
}

interface Entry {
    state: string;
    loggedAt: number;
    held: number;
}

const DEFAULT_EVERY_MS = 60 * 60_000;

// Bounded so a key per request id or path can never grow the map without limit: the oldest key is forgotten first,
// which at worst writes one extra line for it later.
const MAX_KEYS = 2000;

export const createRepeatGate = (options: { readonly everyMs?: number; readonly now?: () => number } = {}): RepeatGate => {
    const everyMs = options.everyMs ?? DEFAULT_EVERY_MS;
    const now = options.now ?? Date.now;
    const entries = new BoundedMap<string, Entry>(MAX_KEYS);

    const check = (key: string, state: string): GateVerdict => {
        const at = now();
        const entry = entries.get(key);
        if (entry === undefined || entry.state !== state || at - entry.loggedAt >= everyMs) {
            const repeated = entry !== undefined && entry.state === state ? entry.held : 0;
            entries.set(key, { state, loggedAt: at, held: 0 });
            return { log: true, repeated };
        }
        entry.held += 1;
        return { log: false, repeated: entry.held };
    };

    const clear = (key: string): { readonly state: string; readonly repeated: number } | undefined => {
        const entry = entries.get(key);
        if (entry === undefined) {
            return undefined;
        }
        entries.delete(key);
        return { state: entry.state, repeated: entry.held };
    };

    return { check, clear };
};
