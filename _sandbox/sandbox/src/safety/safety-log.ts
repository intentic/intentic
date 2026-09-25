import { type SafetyLogEntry, SafetyLogEntrySchema } from "@intentic/sandbox-contract";
import { defineDocument } from "../store/evolution/documents.js";
import { boundedLog, jsonFile } from "../store/json-file.js";
import { stateRelPath } from "../state-paths.js";

// What the safety policy actually decided, newest first: an owner could see a rule was set to "ask me" but not how
// often it fired or on what. Every verdict is recorded, including allows, since a command the judge waved through
// unasked is exactly what "why wasn't I asked" needs answered. Bounded and self-trimming (nothing reads it back to
// decide anything); lives under `.intentic/local/` as derived state.

export const safetyLogDocument = defineDocument({
    path: stateRelPath(".intentic/local/safety-log.json"),
    schema: SafetyLogEntrySchema,
    granularity: "entries",
});

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
        parse: (raw, report) => {
            if (!Array.isArray(raw)) {
                return undefined;
            }
            return raw.flatMap((candidate: unknown, index) => {
                const entry = SafetyLogEntrySchema.safeParse(candidate);
                if (entry.success) {
                    return [entry.data];
                }
                report({ kind: "invalidEntry", detail: `entry ${index + 1} is not a verdict this build can read` });
                return [];
            });
        },
        fallback: () => [],
        document: safetyLogDocument,
    });
    const log = boundedLog(file, KEPT);
    return {
        recent: async () => [...(await log.read())].sort((left, right) => right.at - left.at),
        record: (entry) => log.append(entry),
        // Matched on timestamp AND still-unanswered, not timestamp alone: `Date.now()` repeats within a turn, and
        // matching by timestamp alone would rewrite a neighbour's verdict. `outcome: "asked"` makes the match unique,
        // since a card parks the turn.
        answered: (at, answer, outcome) =>
            log.amend(
                (entry) => entry.at === at && entry.outcome === "asked",
                (entry) => ({ ...entry, answer, outcome }),
            ),
    };
};
