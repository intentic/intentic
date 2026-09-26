import { join } from "node:path";
import { politeGit } from "@intentic/scaffold";
import type { Logger } from "pino";
import { sqliteTurnCheckpoints, type TurnCheckpoints } from "../agent/checkpoints/turn-checkpoints.js";
import { filePromptRecord, type PromptRecord } from "../agent/prompt/prompt-record.js";
import { streamAgent } from "../agent/run/stream-agent.js";
import { turnDoors } from "../agent/run/turn/turn-doors.js";
import { sqliteTurnJournal, type TurnJournal, turnJournalRows } from "../agent/run/turn/turn-journal.js";
import { sqliteWatchJournal, type WatchJournal } from "../agent/verification/watch-journal.js";
import type { Services } from "../composition.js";
import { inLogContext } from "../logger.js";
import type { TurnStarter } from "../seams/turn-starter.js";
import { conversationUnits, type ConversationUnits } from "../store/conversation-units.js";
import { type ConversationsDb, conversationsDbPath, openConversationsDb } from "../store/conversations-db.js";
import type { PerfTracker } from "../system/resources/perf.js";
import type { WorkspaceScopeDeps } from "../workspace/layout/workspace-scope.js";
import type { WorkspacePaths } from "../workspace/workspace.js";
import type { ConversationActors } from "./actor/conversation-actors.js";
import { type ParkedCards, parkedCards } from "./actor/parked-cards.js";
import { createLandedPresences } from "./land/landed-presence.js";
import { type AgentOrigins, createAgentOrigins } from "./land/origins.js";
import { createLandStandings } from "./land/standing.js";
import { type AgentsRegistry, createFleet } from "./registry/agents-registry.js";
import { sqliteAgentsStore } from "./registry/agents-store.js";
import { createExpiryTracker } from "./registry/expiry.js";
import { createTurnIsolation, type TurnIsolation } from "./worktrees/isolation.js";
import { type AgentWorktrees, createAgentWorktrees } from "./worktrees/worktrees.js";

// The conversations: their registry and actors, turns, parked cards, worktrees, journals and checkpoints.
export interface ConversationsSlice {
    // Fleet registry, one entry per isolated conversation; streamAgent runs turns, /agents lists/lands/discards.
    readonly agents: AgentsRegistry;
    // Every conversation's directory on the history volume; the boot sweep takes the ones no registry row owns.
    readonly conversationUnits: ConversationUnits;
    // The database the registry and every row keyed by a conversation live in: as a bundle packs and lands it, and as
    // a person diagnosing one conversation reads it.
    readonly conversationsDb: Pick<ConversationsDb, "snapshot" | "empty" | "adopt" | "rowsOf">;
    // Every door a subsystem starts or drives a turn through: the turn engine's own (agent/run/turn/turn-doors.ts),
    // handed over here so no subsystem imports it.
    readonly turns: TurnStarter;
    // One actor per conversation: its turn lifecycle, leases and in-memory records, and the one way it is disposed.
    readonly conversations: ConversationActors;
    // Every card a turn is parked on, held by those actors' conversations; what /agent/reply resolves.
    readonly cards: ParkedCards;
    // Per-conversation worktree compositions on /history/worktrees: create/repair/remove/prune.
    readonly agentWorktrees: AgentWorktrees;
    // What is in flight right now; cleared on settle, so what remains at boot is what the daemon died under.
    readonly turnJournal: TurnJournal;
    // Armed condition watches; a watch's life is between turns, so only a boot-time read survives a recreate.
    readonly watchJournal: WatchJournal;
    // What each message can be restored to: a workspace checkpoint, or an isolated turn's own per-repo commits.
    readonly turnCheckpoints: TurnCheckpoints;
    // The system prompt each conversation's newest turn ran on, which the transcript never shows.
    readonly promptRecord: PromptRecord;
    // Which agent an uncommitted main-tree file came from, derived from the landed shas.
    readonly agentOrigins: AgentOrigins;
    // Builds an isolated turn's mount namespace; probes capability once, then reports unavailable forever.
    readonly turnIsolation: TurnIsolation;
    // Which copy of the workspace a file read means: the shared tree or one conversation's checkout.
    readonly workspaceScope: WorkspaceScopeDeps;
}

export interface ConversationsDeps {
    readonly historyRoot: string;
    readonly workspace: WorkspacePaths;
    readonly logger: Logger;
    // Worktree ops file into the same tracker the summary line reads.
    readonly perf: PerfTracker;
    // A turn is the one thing here that reaches most of the daemon (agent/run/stream-agent.ts), and it runs long after
    // composing, so its doors read the finished services per turn.
    readonly whole: () => Services;
}

// What else composing reads of the conversations that no route does: the landing caches' sizes, for the resource series.
export interface ConversationsParts {
    readonly slice: ConversationsSlice;
    readonly metrics: () => Readonly<Record<string, Readonly<Record<string, number>>>>;
}

// Builds the conversations slice: one database for the registry and everything keyed by a conversation, so a fact
// spanning its tables is one write.
export const createConversationsSlice = ({ historyRoot, workspace, logger, perf, whole }: ConversationsDeps): ConversationsParts => {
    const conversationsDb = openConversationsDb(conversationsDbPath(historyRoot));
    const agentsStore = sqliteAgentsStore(conversationsDb);
    const units = conversationUnits(historyRoot, agentsStore.has);
    // Shared by the turn path and worktree creation so both read one capability probe.
    const turnIsolation = createTurnIsolation({ root: workspace.root, historyRoot, logger });
    // Built before the registry, which derives a card's land standing through it rather than a stored verdict.
    const agentWorktrees = createAgentWorktrees(
        { workspace, worktreesRoot: join(historyRoot, "worktrees"), historyRoot, isolation: turnIsolation, logger, perf },
        // Demoted: a worktree ensure is bulk agent-plane IO that must lose to the daemon's own loop under contention.
        politeGit,
    );
    // The Changes scan and the turns share one registry; one tracker serves both landing readers' query.
    const landingExpiry = createExpiryTracker();
    const landedPresences = createLandedPresences(agentWorktrees, logger, landingExpiry);
    const { agents, conversations } = createFleet(
        { agents: agentsStore, journal: turnJournalRows(conversationsDb), transaction: conversationsDb.transaction, units },
        createLandStandings(agentWorktrees),
        landedPresences,
    );
    // Its attribution caches report into the resource series, like the presences above.
    const agentOrigins = createAgentOrigins({ agents, logger, expiry: landingExpiry });
    return {
        metrics: () => ({
            agentOrigins: agentOrigins.metrics(),
            landedPresences: landedPresences.metrics(),
            landingExpiry: landingExpiry.metrics(),
        }),
        slice: {
            agents,
            conversationUnits: units,
            conversationsDb,
            // Bound to streamAgent here, the one module that may name the turn body.
            turns: turnDoors(whole, (input, signal) =>
                input.conversationId === undefined
                    ? streamAgent(whole(), input, signal)
                    : inLogContext({ conversationId: input.conversationId }, streamAgent(whole(), input, signal)),
            ),
            conversations,
            cards: parkedCards(conversations),
            agentWorktrees,
            turnJournal: sqliteTurnJournal(conversationsDb),
            // Beside the turn journal, for the same reason: it must outlive a container recreate.
            watchJournal: sqliteWatchJournal(conversationsDb),
            // One instance: the transcript reader holds it too, and a second would answer from a file the first passed.
            turnCheckpoints: sqliteTurnCheckpoints(conversationsDb),
            // Beside the transcript in the conversation's unit: what a conversation is told outlives a container recreate
            // the same way what it said does.
            promptRecord: filePromptRecord(historyRoot),
            agentOrigins,
            turnIsolation,
            workspaceScope: {
                main: workspace.root,
                entry: (id) => agents.entry(id),
                worktreeDir: (id) => agentWorktrees.conversationDir(id),
            },
        },
    };
};
