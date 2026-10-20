import type { AgentStatus, AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { parentOfActor } from "../../auth/principal.js";
import type { ConversationActors } from "../actor/conversation-actors.js";
import { type AgentArchiveDeps, forgetConversations } from "./archive.js";
import { isIsolated, type PersistedAgent } from "./agents-store.js";

// TRANSCRIPT RETENTION (2026-10-13): settings.retention.transcriptDays. Unlike agentRetentionDays, which only puts a
// finished card away, this DELETES: a conversation whose last message is older than the window goes the way the
// archive's Empty takes it (archive.ts purgeArchived, then forgetConversations): its checkout and branch, its rows in
// conversations.db, its unit on the history volume (the record, the system prompt, a fenced conversation's own
// sessions), the runtime session files and the transcript backup (sessions/conversation-purge.ts), its pages and the
// uploads only it named, and its rows in the phrase index. Nothing is left in its place: a tombstone would have to
// carry a title, and a title is the first thing a person typed. What says it happened is the sweep's result (ids and a
// count), which the daemon logs and an audit trail can record.
//
// It never deletes what still has work in it: a conversation running or about to (queued, booked or held messages, a
// re-run booked at a limit's reset, an armed watch, an unsent draft), one asking a question, one holding work nobody
// has landed (ready, conflict), and a parent while any of its children is kept. Those go on the first sweep after they
// settle and age.

// Settled, with nothing left to land or answer.
const SETTLED: ReadonlySet<AgentStatus> = new Set(["idle", "landed", "stopped", "error", "interrupted"]);

export type TranscriptRetentionDeps = AgentArchiveDeps & {
    readonly conversations: Pick<ConversationActors, "turnActive">;
};

export interface TranscriptRetentionResult {
    readonly deleted: readonly string[];
    // Kept this time because removing their checkout failed; tried again on the next sweep.
    readonly failed: number;
}

const idle = (deps: TranscriptRetentionDeps, agent: AgentSummary): boolean =>
    SETTLED.has(agent.status) &&
    !deps.conversations.running(agent.id) &&
    !deps.conversations.turnActive(agent.id) &&
    deps.conversations.queued(agent.id).items.length === 0 &&
    (agent.queue?.items.length ?? 0) === 0 &&
    (agent.watches ?? []).length === 0 &&
    agent.unsentAt === undefined &&
    agent.next === undefined;

// Every conversation aged past the window with nothing in it still to do; a parent only once every child of it goes too.
export const agedConversations = (deps: TranscriptRetentionDeps, now: number, maxAgeMs: number): string[] => {
    if (maxAgeMs <= 0) {
        return [];
    }
    const all = [...deps.agents.list(), ...deps.agents.listArchived()];
    const chosen = new Set(all.filter((agent) => now - agent.updatedAt >= maxAgeMs && idle(deps, agent)).map((agent) => agent.id));
    // A child that stays keeps its parent, whose record it reports to; repeated until nothing more drops out.
    for (let dropped = true; dropped; ) {
        dropped = false;
        for (const agent of all) {
            const parent = parentOfActor(agent.startedBy);
            if (parent !== undefined && chosen.has(parent) && !chosen.has(agent.id)) {
                chosen.delete(parent);
                dropped = true;
            }
        }
    }
    return [...chosen];
};

// Deletes the aged conversations for good; returns what went.
export const deleteAgedConversations = async (deps: TranscriptRetentionDeps, now: number, maxAgeMs: number): Promise<TranscriptRetentionResult> => {
    const removed: PersistedAgent[] = [];
    let failed = 0;
    for (const id of agedConversations(deps, now, maxAgeMs)) {
        const entry = deps.agents.entry(id);
        if (entry === undefined) {
            continue;
        }
        try {
            await deps.turnEngine?.cancelWatchersFor(id);
            await deps.reaper?.reapConversation(id, { force: true });
            if (isIsolated(entry)) {
                await deps.agentWorktrees.remove(id, entry.placement.repos);
            }
            removed.push(entry);
        } catch (error) {
            failed += 1;
            deps.logger.warn({ err: error, id }, "retention: a conversation past its keeping was not deleted, its checkout could not be removed");
        }
    }
    if (removed.length > 0) {
        await forgetConversations(deps, removed);
    }
    return { deleted: removed.map((entry) => entry.id), failed };
};
