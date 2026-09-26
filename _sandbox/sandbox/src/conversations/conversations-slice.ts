import type { TurnCheckpoints } from "../agent/checkpoints/turn-checkpoints.js";
import type { PromptRecord } from "../agent/prompt/prompt-record.js";
import type { TurnJournal } from "../agent/run/turn/turn-journal.js";
import type { WatchJournal } from "../agent/verification/watch-journal.js";
import type { TurnStarter } from "../seams/turn-starter.js";
import type { ConversationUnits } from "../store/conversation-units.js";
import type { ConversationsDb } from "../store/conversations-db.js";
import type { WorkspaceScopeDeps } from "../workspace/layout/workspace-scope.js";
import type { ConversationActors } from "./actor/conversation-actors.js";
import type { ParkedCards } from "./actor/parked-cards.js";
import type { AgentOrigins } from "./land/origins.js";
import type { AgentsRegistry } from "./registry/agents-registry.js";
import type { TurnIsolation } from "./worktrees/isolation.js";
import type { AgentWorktrees } from "./worktrees/worktrees.js";

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
