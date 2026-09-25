import type { InvariantCheck } from "../invariants/invariants.js";
import type { ConversationActors } from "./actor/conversation-actors.js";
import { liveTurnConversations } from "./actor/conversation-holdings.js";
import type { AgentsRegistry } from "./registry/agents-registry.js";
import { isIsolated } from "./registry/agents-store.js";
import type { AgentWorktrees } from "./worktrees/worktrees.js";

// Two independent records of whether a conversation is running (the run each actor holds, the conversation actors'
// own phase) that must agree. Checks only registry-idle-while-turn-live, the direction a live run's own start time
// can verify.

// Long enough that no ordinary begin is still in flight; short enough to catch a stuck card within one sweep.
const REGISTRY_GRACE_MS = 10_000;

export interface FleetRegistryDeps {
    readonly agents: AgentsRegistry;
    readonly conversations: Pick<ConversationActors, "running" | "holdings">;
    readonly agentWorktrees: AgentWorktrees;
    readonly live?: () => readonly { readonly conversationId: string; readonly startedAt: number }[];
    readonly now?: () => number;
}

export const owner = "agents";

export const checks = ({
    agents,
    conversations,
    agentWorktrees,
    live = () => liveTurnConversations(conversations),
    now = Date.now,
}: FleetRegistryDeps): readonly InvariantCheck[] => [
    // A conversation's checkout standing on a branch of its own is invisible from every surface: the turn still writes
    // there, while review and land read `agent/<id>`, which stopped moving. Asked at turn-settled because a switch
    // mid-turn is ordinary (an agent reads main and comes back within seconds) and only the state a turn LEAVES is
    // drift; the sweep catches conversations that will never run again.
    // Reports and never repairs: the one real case was an agent cutting a CI branch to push, and taking its checkout
    // back would have taken that work's context with it.
    {
        name: "checkouts-stand-on-their-own-branch",
        on: ["turn-settled", "sweep"],
        run: async ({ fail }) => {
            const strayed: string[] = [];
            for (const id of agents.ids()) {
                const entry = agents.entry(id);
                // Non-isolated conversations run in the owner's own tree and have no branch of their own to stand on.
                if (entry === undefined || !isIsolated(entry)) {
                    continue;
                }
                for (const { repo, branch } of await agentWorktrees.elsewhere(id, entry.placement.repos)) {
                    strayed.push(`${id}/${repo} on ${branch ?? "a detached HEAD"}`);
                }
            }
            if (strayed.length > 0) {
                fail(
                    `${strayed.length} checkout(s) stand off their conversation's own branch, so its turns write there while review and land read agent/<id>: ${strayed.join(", ")}`,
                );
            }
        },
    },
    {
        name: "live-turns-are-running-on-the-board",
        on: ["sweep", "turn-settled"],
        run: ({ fail }) => {
            const due = live().filter((run) => now() - run.startedAt > REGISTRY_GRACE_MS);
            const known = new Set(agents.ids());
            const unknown = due.filter((run) => !known.has(run.conversationId)).map((run) => run.conversationId);
            if (unknown.length > 0) {
                return fail(`${unknown.length} live turn(s) belong to conversations the fleet registry has no entry for: ${unknown.join(", ")}`);
            }
            const idle = due.filter((run) => !conversations.running(run.conversationId)).map((run) => run.conversationId);
            if (idle.length > 0) {
                fail(
                    `${idle.length} live turn(s) read as not running on the fleet board, the card shows idle while the turn spends: ${idle.join(", ")}`,
                );
            }
        },
    },
];

// Deferred: the mirror direction, a registry `running` with no live turn, isn't checked, since the registry keeps no
// timestamp of when it started, so a mismatch can't be told from a turn one tick from registering.
