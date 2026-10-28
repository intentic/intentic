import type { TranscriptRow } from "./transcript.js";
import { type SandboxNotice, sandboxNoticeOf } from "./sandbox-notice.js";

/* ONE PROBLEM, ONE ROW. A turn refused before it ran leaves a row per attempt: the refusal, the "Sent again" its re-send
   opens with, the same refusal again, and at last the move that got it through. Each row is true, and together they
   read as a pile: one disabled organization drew nine of them on 2026-10-28, with the provider's sentence twice and a
   bright press that would have sent the message into the same wall a third time. This finds those runs, so a reader
   draws each one as a single row (its last: the move that resolved it, the re-send in flight, or the refusal still
   standing) with every attempt behind its details.

   The rows stay as they are in the record: the run is found again wherever it is drawn, so nothing about a stored
   transcript, a rewind index or a fork changes. Only rows next to each other fold. A row between them (the person's
   own message, a rebase, a different refusal) ends the run, since it is part of the story the reader is owed. */

/** One refused attempt an incident folds: when it was refused, and the provider's own sentence for it. */
export interface IncidentAttempt {
    readonly at?: number;
    readonly said: string;
}

/** A run of rows saying one refusal. The row at `to` is the one drawn; the rows from `from` up to it fold into it. */
export interface TranscriptIncident {
    readonly from: number;
    readonly to: number;
    // Oldest first, one per refusal the run holds.
    readonly attempts: readonly IncidentAttempt[];
    // The run ended on the move (or a person's switch) that got the turn through, rather than on a refusal or a re-send.
    readonly resolved: boolean;
}

type Refusal = Extract<SandboxNotice, { code: "kept" | "undelivered" | "failed" }>;

const REFUSALS: ReadonlySet<string> = new Set(["kept", "undelivered", "failed"]);

// The row's notice code where it is one of `codes`.
const codeOf = (row: TranscriptRow, codes: ReadonlySet<string>): string | undefined => {
    const code = row.role === "notice" ? row.noticeCode?.code : undefined;
    return code !== undefined && codes.has(code) ? code : undefined;
};

const RESUMED: ReadonlySet<string> = new Set(["resumed"]);
const MOVED: ReadonlySet<string> = new Set(["accountMoved"]);

// A refusal, the kind of row that repeats once per press: one that ran nothing (kept, or handed back undelivered), or a
// coded failure with nothing run between it and the next (a provider refusing an account it no longer serves comes
// back as one of these, account-not-entitled). A memory hold is not one: it is asked once a spell, and draws a row of
// its own (NoticeMemory in the editor).
const refusalOf = (row: TranscriptRow): Refusal | undefined => {
    // The code alone first: a reader asks this of every row on every frame of a streamed turn, and parsing a row's facts
    // is only worth it for the few that can be one.
    const notice = codeOf(row, REFUSALS) === undefined ? undefined : sandboxNoticeOf(row);
    if (notice?.code !== "kept" && notice?.code !== "undelivered" && (notice?.code !== "failed" || notice.params.error === undefined)) {
        return undefined;
    }
    const memory = notice.params.error === "sandbox-memory-low" || (notice.code === "kept" && notice.params.memory === true);
    return memory ? undefined : notice;
};

// The same refusal again: the same failure code, or for a failure nobody coded, the same words.
const sameRefusal = (first: Refusal, again: Refusal): boolean =>
    first.params.error === undefined ? again.params.error === undefined && again.params.message === first.params.message : again.params.error === first.params.error;

// The re-send of a turn nothing of which ran, as its opening row says it.
const resent = (row: TranscriptRow): boolean => {
    const notice = codeOf(row, RESUMED) === undefined ? undefined : sandboxNoticeOf(row);
    return notice?.code === "resumed" && (notice.params.reason === "door" || notice.params.reason === "refused");
};

const movedOn = (row: TranscriptRow): boolean => codeOf(row, MOVED) !== undefined;

const attemptOf = (row: TranscriptRow, refusal: Refusal): IncidentAttempt =>
    row.openedAt === undefined ? { said: refusal.params.message } : { at: row.openedAt, said: refusal.params.message };

/**
 * Every run of rows that says one refusal, in order. `resolves` names the reader's own rows that end one (the editor's
 * line for an account a person switched to); the sandbox's own move (`accountMoved`) always does. A lone refusal is no
 * run, and is drawn as itself.
 */
export const transcriptIncidents = <R extends TranscriptRow>(rows: readonly R[], resolves: (row: R) => boolean = () => false): TranscriptIncident[] => {
    const found: TranscriptIncident[] = [];
    let index = 0;
    while (index < rows.length) {
        const first = refusalOf(rows[index]!);
        if (first === undefined) {
            index += 1;
            continue;
        }
        const attempts = [attemptOf(rows[index]!, first)];
        let to = index;
        let resolved = false;
        for (let next = index + 1; next < rows.length && !resolved; next += 1) {
            const row = rows[next]!;
            const again = refusalOf(row);
            if (again !== undefined && sameRefusal(first, again)) {
                attempts.push(attemptOf(row, again));
            } else if (movedOn(row) || resolves(row)) {
                resolved = true;
            } else if (!resent(row)) {
                break;
            }
            to = next;
        }
        if (to > index) {
            found.push({ from: index, to, attempts, resolved });
        }
        index = to + 1;
    }
    return found;
};
