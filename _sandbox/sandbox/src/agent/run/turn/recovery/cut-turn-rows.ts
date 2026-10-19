import { isAwaitingDecision, REQUEST_FIELDS, type TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { cancelledRequests } from "@intentic/sandbox-contract/policy/request-status";
import type { Services } from "../../../../composition.js";
import { readRunLog, removeRunLog } from "../../../../sessions/run-log.js";
import { alreadyRecorded, openingRows, recorded, recordUnrecordedRuns, runLogDir } from "../../../../sessions/turn-transcript.js";
import type { RunOptions } from "../turn-runs.js";
import { consumeEntry, type JournalledTurn } from "../../../../store/journals/turn-journal.js";

// What a boot reads of a turn the daemon died under, or one whose record refused it, so it is written down whole and its
// re-run hears what was said into it (turn-resume.ts).

/**
 * The rows a cut turn had drawn: its run's log (sessions/run-log.ts), else the rows its journal entry carried while a
 * card was up. Undefined when neither holds any, and the provider's own store is asked instead (turn-transcript.ts).
 */
export const drawnOf = async (services: Pick<Services, "config">, entry: JournalledTurn): Promise<readonly TranscriptRow[] | undefined> =>
    (await readRunLog(runLogDir(services, entry.turn.conversationId), entry.run?.id))?.rows ?? entry.run?.rows;

/** Takes a cut turn's log away once its rows are on the record. Never throws. */
export const dropRunLog = async (services: Pick<Services, "config" | "logger">, entry: JournalledTurn): Promise<void> => {
    const { conversationId } = entry.turn;
    await removeRunLog(runLogDir(services, conversationId), entry.run?.id).catch((error: Error) =>
        services.logger.warn({ err: error, conversationId, run: entry.run?.id }, "run log: a recorded turn's log stayed"),
    );
};

/**
 * A turn that ended but whose record did not take it: written now, after any earlier run the record also missed, from
 * the log it kept, else the rows its entry carried, and never run again. A record that still refuses keeps the entry
 * for the next boot.
 */
export const recordSettledTurn = async (services: Pick<Services, "config" | "transcripts" | "logger" | "turnJournal">, entry: JournalledTurn): Promise<void> => {
    const { conversationId } = entry.turn;
    const run = entry.run?.id;
    // Its own kept log is among these, oldest first.
    if (!(await recordUnrecordedRuns(services, conversationId))) {
        services.logger.warn({ conversationId, run }, "settled turn: the record still refuses it, kept for the next boot");
        return;
    }
    const rows = entry.run?.rows;
    if (rows !== undefined && !(await alreadyRecorded(services, conversationId, run))) {
        try {
            await services.transcripts.append({ id: conversationId }, recorded(rows));
        } catch (error) {
            services.logger.warn({ err: error, conversationId, run }, "settled turn: the record still refuses it, kept for the next boot");
            return;
        }
    }
    await consumeEntry(services, entry);
    services.logger.info({ conversationId, run }, "settled turn recorded at boot: its record had refused it before the restart");
};

/**
 * What was said into a cut turn while it ran, which its session may never have taken in (a steer the CLI had not read
 * yet when the daemon died): every user row after its opening, for the re-run's note. Undefined when nothing was.
 */
export const saidMidTurn = (rows: readonly TranscriptRow[] | undefined): string | undefined => {
    const said = (rows ?? []).slice(1).filter((row) => row.role === "user" && row.text.trim() !== "");
    if (said.length === 0) {
        return undefined;
    }
    const lines = said.map((row) => `- ${row.speaker?.kind === "sandbox" ? "(the sandbox) " : ""}${row.text.trim()}`);
    return ["What was said into the interrupted turn while it ran, which your session may already hold:", ...lines].join("\n");
};

// A card in a carried-on run's rows that nothing will raise again, frozen as nobody's decision, as the run's end would
// have frozen it: its waiter died with the daemon, so an answer to it would go nowhere.
const frozenUnlessRaised = (row: TranscriptRow, raised: ReadonlySet<string>): TranscriptRow => {
    if (!isAwaitingDecision(row)) {
        return row;
    }
    const stale = Object.fromEntries(
        REQUEST_FIELDS.flatMap((field) => {
            const card = row[field];
            return card?.status === "pending" && !raised.has(card.requestId) ? [[field, card]] : [];
        }),
    );
    return { ...row, ...cancelledRequests(stale) };
};

/* A PARKED RUN COMES BACK AS ITSELF. It carries on under the id, the start and the rows it had when the daemon died,
   so every copy of it agrees: a window that was showing it redraws it in place (its rows are found by that id), the
   record it settles into holds what it did before it asked, and the prompt keeps the time it was sent. A new run that
   told the prompt again drew the prompt and the card a second time beneath the first, answerable twice, and the record
   kept neither the work nor the hour (2026-10-06). An entry an older build journalled holds no rows: that run opens on
   its prompt again, still at the time it was sent. */
export const carriedRun = (services: Pick<Services, "workspace">, entry: JournalledTurn, drawn: readonly TranscriptRow[] | undefined): NonNullable<RunOptions["continues"]> => {
    const raised = new Set((entry.parked ?? []).map((request) => request.requestId));
    const rows = drawn?.map((row) => frozenUnlessRaised(row, raised)) ?? openingRows(entry.turn, services.workspace.root, entry.startedAt);
    return { id: entry.run?.id ?? crypto.randomUUID(), startedAt: entry.startedAt, rows };
};
