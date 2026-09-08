import { type SafetyLogEntry, SafetyLogEntrySchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

// What the safety policy actually decided, newest first: an owner could see a rule was set to "ask me" but not how
// often it fired or on what. Every verdict is recorded, including allows, since a command the judge waved through
// unasked is exactly what "why wasn't I asked" needs answered. Bounded and self-trimming (nothing reads it back to
// decide anything); lives under `.intentic/local/` as derived state.

// Sized to be readable, not complete: enough for a week of ordinary work, small enough to load in one read.
const KEPT = 200;

// The whole program is already in the transcript beside the tool call, so storing it in full here would be a second
// copy.
const EXCERPT = 300;

export const excerptProgram = (program: string): string =>
    program.length <= EXCERPT ? program : `${program.slice(0, EXCERPT)}… (${program.length - EXCERPT} more characters)`;

export interface SafetyLog {
    // Newest first, which is the order the page reads and the only order anybody scans a log in.
    readonly recent: () => Promise<SafetyLogEntry[]>;
    readonly record: (entry: SafetyLogEntry) => Promise<void>;
    // Amends the entry a card left behind once answered. The verdict is logged when reached, not when the card settles,
    // since a stopped turn would otherwise leave no record; `ask` lands immediately as `outcome: "asked"`, this fills
    // in the rest.
    readonly answered: (at: number, answer: SafetyLogEntry["answer"], outcome: SafetyLogEntry["outcome"]) => Promise<void>;
}

export const fileSafetyLog = (path: string): SafetyLog => {
    const file = jsonFile<SafetyLogEntry[]>(path, {
        // A single unreadable entry drops itself, not the whole log: one row from a newer build shouldn't cost a week
        // of evidence.
        parse: (raw) => z.array(SafetyLogEntrySchema).catch([]).parse(raw),
        fallback: () => [],
    });
    return {
        recent: async () => [...(await file.read())].sort((left, right) => right.at - left.at),
        record: async (entry) => {
            await file.update((entries) => [...entries, entry].slice(-KEPT));
        },
        // Matched on timestamp AND still-unanswered, not timestamp alone: `Date.now()` repeats within a turn, and
        // matching by timestamp alone would rewrite a neighbour's verdict. `outcome: "asked"` makes the match unique,
        // since a card parks the turn.
        answered: async (at, answer, outcome) => {
            await file.update((entries) =>
                entries.map((entry) => (entry.at === at && entry.outcome === "asked" ? { ...entry, answer, outcome } : entry)),
            );
        },
    };
};
