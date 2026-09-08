import { type AgentTurn, capabilitiesOf, resumeDisclosure, type TranscriptRow, withoutResumeNote } from "@intentic/sandbox-contract";
import { userRow } from "@intentic/sandbox-contract/transcript-fold";
import { stripAttachmentNote } from "../agent/prompt/attachment-note.js";
import { parseRuntimeHistory } from "../agent/providers/runtime-history.js";
import { takeSteerAnchors } from "../agent/anchors/steer-anchors.js";
import type { Services } from "../composition.js";
import type { TranscriptAgent } from "./agent-transcript.js";

// Strips the daemon's own layers off `turn.prompt` (an outer resume note, a trailing attachment note) to recover the
// user's words; the preamble frame is never among them. `turn.attachments` is authoritative when present; paths are
// workspace-root-relative.
export const openingRows = (
    turn: { readonly prompt: string; readonly attachments?: readonly string[] | undefined },
    root: string,
    // When the turn started; the user row is stamped with this (`TranscriptRow.sentAt`).
    sentAt: number,
): TranscriptRow[] => {
    const resume = resumeDisclosure(turn.prompt);
    const stripped = stripAttachmentNote(resume === undefined ? turn.prompt : withoutResumeNote(turn.prompt));
    const attachments = (turn.attachments ?? stripped.attachments).map((path) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path));
    // A handoff prompt embeds the folded-in transcript (runtime-history.ts); this keeps only what the user typed.
    const text = parseRuntimeHistory(stripped.text)?.prompt ?? stripped.text;
    if (resume?.kind === "notice") {
        // A re-run's interruption replaces the repeated words with one notice row instead of showing the message twice.
        return [{ role: "notice", text: resume.text }];
    }
    if (text.length === 0 && attachments.length === 0) {
        return [];
    }
    const row = userRow(text, sentAt, attachments);
    // An answered-park resume's note rides the user's own row, like every other daemon note.
    return [resume?.kind === "note" ? { ...row, notes: [resume.note] } : row];
};

// Single derivation of which conversation a turn records against, so fork and append can't disagree. Provider/harness
// default to what streamAgent actually ran the turn as (absent means claude/native).
const transcriptAgentOf = (turn: AgentTurn & { readonly conversationId: string }): TranscriptAgent => ({
    id: turn.conversationId,
    provider: turn.agent ?? "claude",
    harness: turn.harness ?? "native",
});

// Opens a fork's record before its first turn, once: only a copy can supply the prefix it inherits from its source.
// Never rejects; a disk failure in this side channel must not fail the turn.
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

// Index this turn starts at, read before it settles (append happens later) to avoid racing the settle hook. Never
// rejects; 0 on failure files the checkpoint at the head, which is recoverable, unlike one pointing past the end.
export const turnStartIndex = async (
    services: Pick<Services, "transcripts" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
): Promise<number> =>
    services.transcripts.count(transcriptAgentOf(turn)).catch((error: unknown) => {
        services.logger.warn({ err: error, conversationId: turn.conversationId }, "transcript count failed");
        return 0;
    });

// Reads this conversation's own record to seed a session after a provider, account, or harness switch retires the old
// one. Empty means either nothing is recorded yet or the turn resumes and needs no seed; never rejects.
export const handoffHistory = async (
    services: Pick<Services, "transcripts" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
): Promise<readonly TranscriptRow[]> =>
    services.transcripts.read(transcriptAgentOf(turn)).catch((error: unknown) => {
        services.logger.warn({ err: error, conversationId: turn.conversationId }, "transcript read for handoff failed");
        return [];
    });

// Strips `checkpointId` and `rewindIndex` before writing: they describe the daemon's current rewind points, which move,
// so a value frozen into the record would go stale. The read looks them up fresh.
const recorded = (rows: readonly TranscriptRow[]): TranscriptRow[] =>
    rows.map((row) => {
        const { checkpointId: _checkpoint, rewindIndex: _index, ...kept } = row;
        return kept;
    });

// Writes one settled turn to the record; every path a turn can start down funnels through this one call. Never rejects;
// the returned boolean lets the restart-recovery path hold a journal entry until the write actually lands.
export const recordTurnTranscript = async (
    services: Pick<Services, "transcripts" | "turnAnchors" | "workspace" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
    rows: readonly TranscriptRow[],
    // Where the user's mid-turn messages sit among `rows`, as the fold placed them (`TranscriptFold.steerRows`).
    steerRows: readonly number[] = [],
): Promise<boolean> => {
    const agent = transcriptAgentOf(turn);
    // Read outside the try block, so a failing count doesn't take the whole transcript append down with it.
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

// How many rows this conversation's record already holds, or undefined on failure. try/catch rather than `.catch`,
// since a store missing this member throws where it's called, not as a rejected promise.
const recordedCount = async (services: Pick<Services, "transcripts">, agent: TranscriptAgent): Promise<number | undefined> => {
    try {
        return await services.transcripts.count(agent);
    } catch {
        return undefined;
    }
};

// Files a steer's pinned state under the row index it landed on, computed only once the turn settles. Drains the queue
// regardless, since a leftover would be misfiled under the next turn's rows; never throws.
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

// Message a died-under turn's record ends with, kept beside the write it closes.
export const RESTART_INTERRUPTED = "The sandbox restarted before this turn finished. Send another message to continue from the saved worktree.";

// Recovers what an interrupted turn wrote from the provider's own session store, the only place it exists once a turn
// never settles to disk. The opening row is restamped to the turn's start so its clock matches every other row's.
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

// Writes a turn the daemon died under, at the boot that still finds its journal entry (turn-resume.ts); prefers
// recovered session rows over the prompt-alone fallback used when nothing is recoverable. Never throws; a failed write
// keeps the journal entry for the next boot.
export const recordInterruptedTurn = async (
    services: Pick<Services, "transcripts" | "sessions" | "workspace" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
    // Session the dead turn last reported, off its journal entry; the registry entry may never have gotten it.
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
