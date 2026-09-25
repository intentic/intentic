import { join } from "node:path";
import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { TurnCheckpoints } from "../agent/checkpoints/turn-checkpoints.js";
import type { PersistedAgent } from "../conversations/registry/agents-store.js";
import type { AgentArchiveDeps } from "../conversations/registry/archive.js";
import {
    agentToolChildren,
    agentTranscript,
    type AgentTranscriptDeps,
    agentTranscriptPage,
    spokenTranscript,
    type TranscriptAgent,
} from "./agent-transcript.js";
import { purgeConversationState } from "./conversation-purge.js";
import { migrateOnThreads } from "./record/record-migration.js";
import { backfillSearchIndex, type BackfillSource } from "./search-backfill.js";
import { openSearchIndex, type SearchIndex } from "./search-index.js";
import {
    createRecentSessions,
    listWorkspaceSessions,
    readWorkspaceSession,
    readWorkspaceSessionTail,
    searchWorkspaceSessions,
    type SessionSummary,
    workspaceSessionExists,
} from "./sessions.js";
import { BLOB_GRACE_MS, fileTranscriptRecord, type TranscriptPage, type TranscriptWindow } from "./transcript-record.js";
import { readSessionLines, spokenLinesOf } from "./transcript-search.js";

// Transcripts and sessions: the durable record, the session files, phrase search, and a conversation's purge.
export interface SessionsSlice {
    readonly sessions: {
        readonly list: (dir: string) => Promise<SessionSummary[]>;
        readonly read: (dir: string, id: string) => Promise<TranscriptRow[]>;
        // The turn begun at `since` (epoch ms) in a session that never settled; what the boot pass writes in its place.
        readonly readTail: (dir: string, id: string, since: number) => Promise<TranscriptRow[]>;
        // No dir, unlike its neighbours: search reads the phrase index and the workspace listing, both built once.
        readonly search: (query: string, caseSensitive: boolean) => Promise<SessionSummary[]>;
        readonly exists: (dir: string, id: string) => Promise<boolean>;
    };
    // A conversation's transcript, keyed by conversationId, surviving an archive, a retired worktree, a swap.
    readonly transcripts: {
        // The whole record, for readers that cannot take a piece: a share, a runtime handoff, a subagent, self-recall.
        readonly read: (agent: TranscriptAgent) => Promise<TranscriptRow[]>;
        // Every row as a page reads it: for a reader of what was said (a digest, a subject line), which the out-of-line
        // outputs would only slow.
        readonly rows: (agent: TranscriptAgent) => Promise<TranscriptRow[]>;
        // One page, newest turns by default, window walking back; what a chat tab opening asks for.
        readonly page: (agent: TranscriptAgent, window?: TranscriptWindow) => Promise<TranscriptPage>;
        // The calls under one tool card, which a page counts rather than carries; read on the press that opens it.
        readonly toolChildren: (agent: TranscriptAgent, toolId: string) => Promise<TranscriptTool[]>;
        // The newest assistant row's prose, read back from the tail rather than the whole record; what a land reads.
        readonly lastSaid: (agent: TranscriptAgent) => Promise<string | undefined>;
        // Opens a branch's record as a copy of the source's first `keep` rows; a no-op once the record exists.
        readonly fork: (agent: TranscriptAgent, source: string, keep: number) => Promise<void>;
        readonly append: (agent: TranscriptAgent, messages: readonly TranscriptRow[]) => Promise<void>;
        // How many messages are stored, the position the next turn starts at and its checkpoint is filed under.
        readonly count: (agent: TranscriptAgent) => Promise<number>;
        // Drops everything after the message a rewind returned to; returns how many went.
        readonly truncate: (agent: TranscriptAgent, keep: number) => Promise<number>;
        // Converts every record still in the plain format (record/record-migration.ts); the root role's pass behind boot.
        readonly migrate: (signal?: AbortSignal) => Promise<void>;
        // Removes the blobs no record names but those of `gone`, once the migration has ended; never throws.
        readonly sweep: (gone: ReadonlySet<string>) => Promise<void>;
    };
    // What was said, indexed: what the fleet filter and chat-history search answer from, written as turns settle.
    readonly saidIndex: {
        // One query, one round trip; async here only so a test harness can substitute a fake without going synchronous.
        readonly search: SearchIndex["search"];
        // Brings the index level with the stores; detached at boot and after a sweep, a no-op if nothing's behind.
        readonly backfill: (signal?: AbortSignal) => Promise<void>;
        // Whether a backfill is running, whether the answer can still grow; both search routes report it as partial.
        readonly indexing: () => boolean;
    };
    readonly purgeConversationState: NonNullable<AgentArchiveDeps["purgeConversationState"]>;
}

export interface SessionsDeps {
    readonly historyRoot: string;
    readonly workspaceRoot: string;
    readonly logger: Logger;
    readonly turnCheckpoints: TurnCheckpoints;
    // Every conversation the phrase index backfills from, read when a backfill runs.
    readonly roster: () => readonly PersistedAgent[];
    // What else a purged conversation leaves behind that must go with it.
    readonly forget: (conversationId: string) => void;
}

// Builds the sessions slice: the durable record, its blob sweeps, the phrase index and its backfill, and the purge.
export const createSessionsSlice = (deps: SessionsDeps): { readonly slice: SessionsSlice; readonly saidIndexMetrics: () => unknown } => {
    const { historyRoot } = deps;
    const transcriptRecord = fileTranscriptRecord(historyRoot);
    const transcriptDeps: AgentTranscriptDeps = { record: transcriptRecord, turnCheckpoints: deps.turnCheckpoints };
    // The boot's record migration while it runs: its threads write blobs no sweep may judge before it ends.
    let migrating: Promise<unknown> = Promise.resolve();
    const sweepBlobsNow = async (gone: ReadonlySet<string>): Promise<void> => {
        await migrating;
        const removed = await transcriptRecord.sweep(gone).catch((error: unknown) => {
            deps.logger.warn({ err: error }, "records: blob sweep failed");
            return 0;
        });
        if (removed > 0) {
            deps.logger.info({ removed }, "records: removed blobs no record names");
        }
    };
    let sweepAgain: ReturnType<typeof setTimeout> | undefined;
    // Again once the grace has passed, for what was named too recently to judge: a record purged right after its turn.
    const sweepRecordBlobs = async (gone: ReadonlySet<string>): Promise<void> => {
        sweepAgain ??= setTimeout(() => {
            sweepAgain = undefined;
            void sweepBlobsNow(new Set());
        }, BLOB_GRACE_MS);
        sweepAgain.unref();
        await sweepBlobsNow(gone);
    };
    // Phrase index on the history volume, daemon-private; a pure cache, deleted and rebuilt on a schema bump.
    const saidIndex = openSearchIndex(join(historyRoot, "said-index"));
    // One listing of the session window, shared by search and backfill, so a keystroke burst costs one stat pass.
    const recentSessions = createRecentSessions(deps.workspaceRoot);
    // Version an indexed conversation is pinned to: its record's byte size; undefined (no record) is a version too.
    const recordVersion = async (id: string): Promise<string | undefined> => {
        const size = await transcriptDeps.record.size(id);
        return size === undefined ? undefined : String(size);
    };
    // Brings the index level with both stores in one pass: the roster's own list, and the session list's window.
    const runSaidBackfill = async (signal?: AbortSignal): Promise<void> => {
        const roster = deps.roster();
        await backfillSearchIndex(
            saidIndex,
            {
                kind: "conversation",
                prune: false,
                sources: roster.map((entry): BackfillSource => ({
                    key: entry.id,
                    version: () => recordVersion(entry.id),
                    lines: () => spokenTranscript(transcriptDeps, entry),
                })),
            },
            deps.logger,
            signal,
        );
        if (signal?.aborted === true) {
            return;
        }
        const listed = await recentSessions().catch((error: unknown) => {
            deps.logger.warn({ err: error }, "search backfill: recent sessions could not be read");
            return [];
        });
        await backfillSearchIndex(
            saidIndex,
            {
                kind: "session",
                prune: true,
                sources: listed.map((session): BackfillSource => ({
                    key: session.id,
                    // The session file's own mtime, already read by the list; an append moves it, nothing else to open.
                    version: async () => String(session.updatedAt),
                    lines: () => readSessionLines(deps.workspaceRoot, session.id),
                })),
            },
            deps.logger,
            signal,
        );
    };
    // Reentrancy guard and the flag both search routes report; a search taken mid-backfill is legitimately partial.
    let backfillingSaid = false;
    const backfillSaidIndex = async (signal?: AbortSignal): Promise<void> => {
        if (backfillingSaid) {
            return;
        }
        backfillingSaid = true;
        try {
            await runSaidBackfill(signal);
        } finally {
            backfillingSaid = false;
        }
    };
    return {
        saidIndexMetrics: () => saidIndex.metrics(),
        slice: {
            sessions: {
                list: listWorkspaceSessions,
                read: readWorkspaceSession,
                readTail: readWorkspaceSessionTail,
                // Bound to this daemon's one index, so the history box and the fleet board answer from the same rows.
                search: (query, caseSensitive) =>
                    searchWorkspaceSessions(recentSessions, query, caseSensitive, saidIndex.search),
                exists: workspaceSessionExists,
            },
            transcripts: {
                read: (agent) => agentTranscript(transcriptDeps, agent),
                rows: (agent) => transcriptDeps.record.rows(agent.id),
                page: (agent, window) => agentTranscriptPage(transcriptDeps, agent, window),
                toolChildren: (agent, toolId) => agentToolChildren(transcriptDeps, agent, toolId),
                lastSaid: async (agent) => (await transcriptDeps.record.findBack(agent.id, (row) => row.role === "assistant"))?.text,
                // A branch's opening history is the source conversation's record, copied once.
                fork: (agent, source, keep) => transcriptDeps.record.fork(agent.id, source, keep),
                // Written right after the record, best-effort: a failed index write is fixed by the next backfill.
                append: async (agent, messages) => {
                    await transcriptDeps.record.append(agent.id, messages);
                    try {
                        await saidIndex.extend(agent.id, "conversation", (await recordVersion(agent.id)) ?? "none", spokenLinesOf(messages));
                    } catch (error) {
                        deps.logger.warn({ err: error, conversationId: agent.id }, "search index: turn not indexed");
                    }
                },
                count: (agent) => transcriptDeps.record.count(agent.id),
                // A rewind shortens the record; the index is re-stated whole from it, never appended.
                truncate: async (agent, keep) => {
                    const dropped = await transcriptDeps.record.truncate(agent.id, keep);
                    try {
                        await saidIndex.put(agent.id, "conversation", (await recordVersion(agent.id)) ?? "none", await spokenTranscript(transcriptDeps, agent));
                    } catch (error) {
                        deps.logger.warn({ err: error, conversationId: agent.id }, "search index: rewind not reindexed");
                    }
                    return dropped;
                },
                migrate: async (signal) => {
                    const pass = migrateOnThreads(
                        {
                            historyRoot,
                            adopt: transcriptRecord.adopt,
                            indexed: () => saidIndex.versions("conversation"),
                            repin: (id, pinned) => saidIndex.extend(id, "conversation", pinned, []),
                            logger: deps.logger,
                        },
                        signal,
                    );
                    // allow(silent-catch): this pass's caller has its rejection from `await pass`; `migrating` only lets a later one wait it out.
                    migrating = pass.catch(() => undefined);
                    await pass;
                },
                sweep: sweepRecordBlobs,
            },
            saidIndex: {
                search: saidIndex.search,
                backfill: backfillSaidIndex,
                indexing: () => backfillingSaid,
            },
            // The index goes with the state; a purged conversation's rows would otherwise still be findable by phrase.
            purgeConversationState: async (removed, retained) => {
                await purgeConversationState(deps.workspaceRoot, historyRoot, transcriptRecord.stored, removed, retained);
                for (const entry of removed) {
                    await saidIndex.forget(entry.id);
                    deps.forget(entry.id);
                }
                // Detached: what the removed records alone named goes with them, never what a purge waits on.
                void sweepRecordBlobs(new Set(removed.map((entry) => entry.id)));
            },
        },
    };
};
