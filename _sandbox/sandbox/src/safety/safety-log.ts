import { type SafetyLogEntry, SafetyLogEntrySchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* WHAT THE SAFETY POLICY ACTUALLY DECIDED, newest first, and the reason the Safety page is two halves rather
 * than one.
 *
 * The old page was six switches and no evidence. An owner could see that `files.destructive` was set to "ask
 * me" and could not see that it had asked them eleven times that week, nine of them about a `rg` invocation.
 * That is the exact information needed to write a better rule, and it existed nowhere. A written policy makes
 * this worse before it makes it better: prose can say anything, so an owner who cannot see what their words did
 * has no way to find out that "be strict about deletes" is being read more strictly than they meant.
 *
 * So every verdict is recorded, INCLUDING THE ALLOWS, which are most of them and are the entries that matter
 * most. A card the owner answered is a thing they already know about; a command the judge waved through on
 * their policy's say-so is not, and "why wasn't I asked about that" is the question this file exists to answer.
 *
 * BOUNDED AND SELF-TRIMMING. This is written several times a turn on a busy one, and it is evidence rather than
 * state — nothing reads it back to make a decision. A ring of the most recent entries is what a page can render
 * and what an owner can actually read; an unbounded ledger would grow without anybody ever looking at its tail.
 *
 * It lives under `.intentic/local/` because that is where `derived` state goes, and the folder is what the git
 * exclude, the search allow-list and the export bundle actually read (sandbox-contract's workspace-state.ts).
 */

// How many verdicts are kept. Sized to be readable rather than complete: enough that a week of ordinary work is
// still in it, small enough that the page loads it in one read and nobody scrolls forever looking for a pattern.
const KEPT = 200;

// The program as the log holds it. The whole text is in the transcript beside the tool call either way, so a
// log that stored every heredoc in full would be the sandbox keeping a second copy of everything it ran.
const EXCERPT = 300;

export const excerptProgram = (program: string): string =>
    program.length <= EXCERPT ? program : `${program.slice(0, EXCERPT)}… (${program.length - EXCERPT} more characters)`;

export interface SafetyLog {
    // Newest first, which is the order the page reads and the only order anybody scans a log in.
    readonly recent: () => Promise<SafetyLogEntry[]>;
    readonly record: (entry: SafetyLogEntry) => Promise<void>;
    /* AMEND THE ENTRY A CARD LEFT BEHIND, once the person answers it. The verdict is logged when it is reached,
     * not when the card settles, because a turn can be stopped while a card is up and a verdict that never got
     * written is a verdict the owner cannot find out about. So `ask` lands immediately as `outcome: "asked"`,
     * and this fills in how it ended. */
    readonly answered: (at: number, answer: SafetyLogEntry["answer"], outcome: SafetyLogEntry["outcome"]) => Promise<void>;
}

export const fileSafetyLog = (path: string): SafetyLog => {
    const file = jsonFile<SafetyLogEntry[]>(path, {
        // A single unreadable entry drops itself rather than the whole log: this is evidence, and losing a
        // week of it because one row came from a newer build would be the worst possible trade.
        parse: (raw) => z.array(SafetyLogEntrySchema).catch([]).parse(raw),
        fallback: () => [],
    });
    return {
        recent: async () => [...(await file.read())].sort((left, right) => right.at - left.at),
        record: async (entry) => {
            await file.update((entries) => [...entries, entry].slice(-KEPT));
        },
        /* Matched on the timestamp AND on the entry still being unanswered, not on the timestamp alone.
         * `Date.now()` repeats: two commands judged inside the same millisecond is ordinary on a turn that runs
         * a handful of flagged commands in a row, and amending by timestamp alone would rewrite a neighbouring
         * verdict as though somebody had answered it. Narrowing to `outcome: "asked"` is what makes the match
         * unique in practice — a card parks the turn, so two of them cannot be raised in the same millisecond. */
        answered: async (at, answer, outcome) => {
            await file.update((entries) =>
                entries.map((entry) => (entry.at === at && entry.outcome === "asked" ? { ...entry, answer, outcome } : entry)),
            );
        },
    };
};
