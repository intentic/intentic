import { type AgentTurn, capabilitiesOf, resumeDisclosure, type TranscriptRow, withoutResumeNote } from "@intentic/sandbox-contract";
import { userRow } from "@intentic/sandbox-contract/transcript-fold";
import { stripAttachmentNote } from "../agent/attachment-note.js";
import { parseRuntimeHistory } from "../agent/runtime-history.js";
import { takeSteerAnchors } from "../agent/steer-anchors.js";
import type { Services } from "../composition.js";
import type { TranscriptAgent } from "./agent-transcript.js";

/* WHAT A TURN OPENS WITH, the row its transcript starts from: the user's words, with what the daemon layered
 * onto them taken back off. The fold that turns the turn's frames into the rest of its rows lives in the
 * contract (transcript-fold.ts) and runs inside the run as the frames arrive (agent/turn-runs.ts); this is the
 * one part only the daemon can do, because only the daemon knows what it put on the prompt.
 *
 * `turn.prompt` is the user's words with at most two daemon layers on them, the note saying what interrupted a
 * turn it re-ran (outermost, events.ts) and the trailing attachment note, and both come back off here: they are
 * not what the user typed and must not redraw as their words. The turn PREAMBLE is not among them: notes ride
 * the request typed and reach the transcript through the `preamble` frame the fold reads, never through the
 * prompt. `turn.attachments` is the authoritative list when the client sent one, the note is only the Claude
 * path's way of carrying it, and the other adapters word it differently. The paths are relative to the
 * workspace root the turn actually saw. */
export const openingRows = (
    turn: { readonly prompt: string; readonly attachments?: readonly string[] | undefined },
    root: string,
    // When the turn started, the moment its user row is stamped with (TranscriptRow.sentAt).
    sentAt: number,
): TranscriptRow[] => {
    const resume = resumeDisclosure(turn.prompt);
    const stripped = stripAttachmentNote(resume === undefined ? turn.prompt : withoutResumeNote(turn.prompt));
    const attachments = (turn.attachments ?? stripped.attachments).map((path) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path));
    /* A handoff turn's prompt opens with the transcript the daemon folded into it (runtime-history.ts). Unwrap
     * that and keep only what the user actually typed: the rows inside the envelope are this conversation's OWN
     * earlier messages, which its record already holds. */
    const text = parseRuntimeHistory(stripped.text)?.prompt ?? stripped.text;
    if (resume?.kind === "notice") {
        // A re-run of words the record already holds: the interruption goes down INSTEAD of them, one row for
        // one row, so the reader sees why the answer below carries on rather than the same message twice.
        return [{ role: "notice", text: resume.text }];
    }
    if (text.length === 0 && attachments.length === 0) {
        return [];
    }
    const row = userRow(text, sentAt, attachments);
    // The answered-park resume explains itself on the user's own row, the same collapsed disclosure every other
    // daemon-written note gets.
    return [resume?.kind === "note" ? { ...row, notes: [resume.note] } : row];
};

/* WHICH conversation a turn records against, one derivation, because the record's two halves (fork, append)
 * must agree on it or a turn adopts into one file and settles into another. The provider/harness defaults are
 * the ones streamAgent resolves the turn under (absent ⇒ claude/native), so the record is keyed by what the
 * turn actually ran as. */
const transcriptAgentOf = (turn: AgentTurn & { readonly conversationId: string }): TranscriptAgent => ({
    id: turn.conversationId,
    provider: turn.agent ?? "claude",
    harness: turn.harness ?? "native",
});

/* OPEN a FORK's record before its first turn reaches the provider, and only ever once: its opening history is a
 * prefix of the conversation it was cut from, which nothing but a copy could supply, the fork is a new
 * conversation nothing else knows about yet. From the copy onward it is an ordinary conversation: it seeds a
 * switched session from its own record like any other, and it reads back with the turns it inherited rather
 * than beginning abruptly at the cut. Every other conversation's record is created by its first settled turn's
 * append and needs no opening.
 *
 * Never rejects, like the append below: a disk failure in a side channel must not manufacture an agent failure. */
export const openTurnTranscript = async (
    services: Pick<Services, "transcripts" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
): Promise<void> => {
    const fork = turn.forkOf;
    if (fork === undefined) {
        return;
    }
    await services.transcripts
        .fork(transcriptAgentOf(turn), fork.conversationId, fork.keep)
        .catch((error: unknown) => services.logger.warn({ err: error, conversationId: turn.conversationId }, "transcript fork failed"));
};

/* WHERE THIS TURN SITS IN ITS CONVERSATION, the index its checkpoint is filed under, and the number of
 * messages a rewind to it keeps.
 *
 * Read at turn START, in the window every path guarantees: the record has been opened (a fork's copy awaited
 * first), and this turn's own messages are not appended until it settles. Measured at the END instead it would
 * be a race, the settle hook's append and the end-of-turn snapshot are not ordered against each other, so the
 * index would sometimes already count the very turn it is naming.
 *
 * Never rejects. 0 on failure files the checkpoint at the head of the conversation: a rewind that goes further
 * back than it should is still recoverable (restore takes its own pre-restore checkpoint first), whereas an
 * index pointing past the end of the transcript addresses a message that never existed. */
export const turnStartIndex = async (
    services: Pick<Services, "transcripts" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
): Promise<number> =>
    services.transcripts.count(transcriptAgentOf(turn)).catch((error: unknown) => {
        services.logger.warn({ err: error, conversationId: turn.conversationId }, "transcript count failed");
        return 0;
    });

/* THE TRANSCRIPT A FRESH SESSION IS SEEDED WITH, this conversation's own record, read at turn start for a turn
 * that resumes nothing.
 *
 * A provider, account or harness switch retires the session (a session id only resumes on the runtime and
 * credential that minted it), so its replacement starts blank and has to be told what came before. That used to
 * be the CLIENT's job, it shipped a text mirror of its own bubbles up with the turn, which meant the daemon
 * ignored the fuller account it keeps itself, and a conversation opened in a second window seeded from whatever
 * that window had happened to paint. This is the same record every other reader of the conversation already
 * uses, so a handoff carries tool calls and attachments the text mirror never had.
 *
 * Empty is the ordinary answer twice over: the first turn of a conversation has nothing recorded yet, and a turn
 * that RESUMES is never asked (its session carries its own context). Both mean "send the prompt alone".
 *
 * Never rejects. A transcript the daemon cannot read costs this turn its continuity, which is bad; failing the
 * turn outright over a side-channel read is worse. */
export const handoffHistory = async (
    services: Pick<Services, "transcripts" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
): Promise<readonly TranscriptRow[]> =>
    services.transcripts.read(transcriptAgentOf(turn)).catch((error: unknown) => {
        services.logger.warn({ err: error, conversationId: turn.conversationId }, "transcript read for handoff failed");
        return [];
    });

/* A row as the RECORD keeps it: without the checkpoint the read stamps back on. A checkpoint id and a rewind
 * index describe the daemon's rewind points as they stand, which a rewind rewrites, so a value frozen into the
 * record would keep offering turns a previous rewind already dropped. The read looks them up fresh
 * (agent-transcript.ts); the live row carries them because the live row is what the reader sees now. */
const recorded = (rows: readonly TranscriptRow[]): TranscriptRow[] =>
    rows.map((row) => {
        const { checkpointId: _checkpoint, rewindIndex: _index, ...kept } = row;
        return kept;
    });

/* WRITE one settled turn to that record, the single spelling of that, because every road a turn can be started
 * down ends here: the /agent pump (turn-runs' settle hook), an automation wake, a landing-gate fix. The rows are
 * the run's own, folded as the turn streamed, so what the record keeps is what every window saw.
 *
 * Never rejects. A transcript is a side-channel of a turn that has already finished, the cost of a failed
 * write is one turn missing from a history, which must not become the cost of the turn itself. The boolean lets
 * the restart recovery path keep an interrupted journal entry until this write really landed; ordinary settled
 * turns use the awaited call only as an ordering boundary. */
export const recordTurnTranscript = async (
    services: Pick<Services, "transcripts" | "turnAnchors" | "workspace" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
    rows: readonly TranscriptRow[],
    // Where the user's mid-turn messages sit among the rows, as the fold placed them (TranscriptFold.steerRows).
    steerRows: readonly number[] = [],
): Promise<boolean> => {
    const agent = transcriptAgentOf(turn);
    /* Read BEFORE the append, which is what makes it this turn's start index: the same number turnStartIndex
     * takes at the top of the turn, in the same window (the record is open, this turn's rows are not in it yet).
     * Taken here rather than passed down from there because only this side knows how many rows the fold actually
     * wrote, and the two have to be added together to place a message steered into the turn.
     *
     * And OUTSIDE the guard below, which is the point: this is bookkeeping for a bookmark, and the write it sits
     * beside is the conversation itself. Inside, a store that cannot answer this — a count that fails, a caller
     * whose record does not implement one — took the turn's whole transcript down with it. */
    const base = await recordedCount(services, agent);
    try {
        await services.transcripts.append(agent, recorded(rows));
        await recordSteerAnchors(services, turn.conversationId, steerRows, base);
        return true;
    } catch (error) {
        services.logger.warn({ err: error, conversationId: turn.conversationId }, "transcript append failed");
        return false;
    }
};

/* HOW MANY ROWS THIS CONVERSATION'S RECORD ALREADY HOLDS, or nothing, said in a way that cannot fail upward.
 *
 * try/catch rather than a rejection handler, because the two failures are shaped differently and only one of
 * them is a rejected promise: a store missing this member at all throws where it is CALLED, which no `.catch`
 * on the result can see. Undefined is a complete answer — the caller then files no bookmark for this turn's
 * steers, rather than filing one at a position it guessed. */
const recordedCount = async (services: Pick<Services, "transcripts">, agent: TranscriptAgent): Promise<number | undefined> => {
    try {
        return await services.transcripts.count(agent);
    } catch {
        return undefined;
    }
};

/* FILE THE STATES PINNED MID-TURN UNDER THE ROWS THEY TURNED OUT TO BE (agent/steer-anchors.ts).
 *
 * This is the second half of a steer's bookmark, and the half that could only ever happen here: the state was
 * captured when the message arrived, because that is the only moment it exists, and its index is knowable only
 * now, because until the turn settled nobody knew how many rows it wrote before it.
 *
 * The queue drains whatever happens, including when this cannot use it — a turn whose count could not be read,
 * a record that took fewer rows than the queue holds — because a box left behind would be picked up by the NEXT
 * turn and filed under one of ITS rows, which is the mis-indexing this whole path is careful about.
 *
 * Never throws: a bookmark is a side-channel of a turn that has already finished. */
const recordSteerAnchors = async (
    services: Pick<Services, "turnAnchors" | "logger">,
    conversationId: string,
    positions: readonly number[],
    base: number | undefined,
): Promise<void> => {
    const anchors = takeSteerAnchors(conversationId);
    if (base === undefined) {
        return;
    }
    await Promise.all(
        positions.map(async (position, at) => {
            const anchor = anchors[at];
            if (anchor === undefined) {
                return;
            }
            await services.turnAnchors
                .record(conversationId, base + position, anchor)
                .catch((error: unknown) => services.logger.warn({ err: error, conversationId }, "anchors: filing a steered message failed"));
        }),
    );
};

// The line a turn the daemon died under leaves under whatever it managed to write: what stopped it, and the one
// move that carries the conversation on from here. Lives beside the recording rather than at the boot pass that
// asks for it, so the sentence and the rows it closes are written in one place.
export const RESTART_INTERRUPTED = "The sandbox restarted before this turn finished. Send another message to continue from the saved worktree.";

/* WHAT THE INTERRUPTED TURN ACTUALLY WROTE, recovered from the provider's own session store.
 *
 * The one provider-shaped read left, and a RECOVERY rather than a road any ordinary turn goes down: a turn's
 * rows live in the daemon's memory and die with it, so for a turn nothing ever settled the provider's store is
 * the only place its work exists. `undefined` for a runtime that keeps no readable store (codex/grok NATIVE,
 * every ACP agent) and for a turn that never reported a session, which is not a failure, the caller writes the
 * prompt alone.
 *
 * The opening row is stamped with when the TURN started. The store knows when the provider received the prompt
 * and the daemon knows when the user sent it, and the second is what every other user row in this record
 * carries, so a recovered turn must not be the one message in a conversation whose clock comes from somewhere
 * else. */
const interruptedTurnRows = async (
    services: Pick<Services, "sessions" | "workspace" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
    sessionId: string | undefined,
    sentAt: number,
): Promise<readonly TranscriptRow[]> => {
    const agent = transcriptAgentOf(turn);
    if (sessionId === undefined || capabilitiesOf(agent.provider, agent.harness).runtime !== "claude-code") {
        return [];
    }
    const rows = await services.sessions.readTail(services.workspace.root, sessionId).catch((error: unknown) => {
        services.logger.warn({ err: error, conversationId: turn.conversationId, sessionId }, "interrupted turn: session tail unreadable");
        return [] as TranscriptRow[];
    });
    const [opening, ...rest] = rows;
    return opening === undefined ? [] : [opening.role === "user" ? { ...opening, sentAt } : opening, ...rest];
};

/* WRITE DOWN A TURN THE DAEMON DIED UNDER, at the boot that finds its journal entry still standing
 * (turn-resume.ts). The one write that is not a settled turn, and the last chance this turn is ever recorded:
 * the journal entry naming it is consumed in the same pass.
 *
 * It used to record the PROMPT and the interruption, nothing else, on the reasoning that a turn with no settled
 * transcript at least should not lose the user's words. That left the far bigger half on the floor. An
 * interrupted turn is usually a LONG one, an hour of tool calls is exactly the shape of thing a container
 * rebuild or an OOM lands in the middle of, and every line of it was already on disk in the provider's session
 * file. What the chat opened onto was the user's own message with a notice under it, over work that had really
 * happened, which reads as "nothing came of this" about a turn that got most of the way.
 *
 * The prompt-alone shape is still the FALLBACK, for the cases where there is genuinely nothing to recover: a
 * runtime with no readable store, a turn killed before it reported a session, a store that has since lost the
 * file. Nothing about those is an error; they are the conversations this used to be the whole answer for.
 *
 * Never throws. The boolean is the caller's, and it is load-bearing rather than informational: a failed write
 * means the journal entry is KEPT for the next boot instead of a transient disk error turning into permanent
 * loss (see turn-resume.ts). */
export const recordInterruptedTurn = async (
    services: Pick<Services, "transcripts" | "sessions" | "workspace" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
    // The session the dead turn last reported, off its journal entry, which is where that id survives a daemon
    // that never got to write it onto the registry entry.
    sessionId: string | undefined,
    sentAt: number,
): Promise<boolean> => {
    const recovered = await interruptedTurnRows(services, turn, sessionId, sentAt);
    const written = recovered.length > 0 ? recovered : openingRows(turn, services.workspace.root, sentAt);
    try {
        await services.transcripts.append(transcriptAgentOf(turn), [...written, { role: "notice", text: RESTART_INTERRUPTED }]);
        return true;
    } catch (error) {
        services.logger.warn({ err: error, conversationId: turn.conversationId }, "interrupted turn: transcript append failed");
        return false;
    }
};
