import { parentOfActor } from "../../auth/principal.js";
import type { IsolatedAgent, PersistedAgent } from "../registry/agents-store.js";
import type { ConversationActors } from "../actor/conversation-actors.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";

// WHERE A CONVERSATION'S FINISHED WORK GOES, and so what its branch is rebased onto. A conversation of its own lands in
// the main tree, under the sandbox's landing rules. A spawned child works for its parent the way the parent's in-process
// subagents do (the runtime's own Agent tool, editing the parent's checkout): its work goes into the parent's own
// checkout, and the whole family reaches the owner's tree through the parent's one land. Nothing of the landing rules
// applies on that way, since nothing reaches the owner's tree there; the parent's own land is what they judge. A parent
// working in the main tree takes it there, as its in-process subagents write there. A parent that cannot take it at all
// (archived, gone, on another machine, or without a checkout of one of the child's repos) leaves the child to land as
// any conversation does.

export type LandTarget =
    // `ruled`: whether the sandbox's landing rules decide. Not for a child whose parent works in the main tree.
    | { readonly kind: "main"; readonly ruled: boolean }
    | { readonly kind: "parent"; readonly parent: string };

const OWN: LandTarget = { kind: "main", ruled: true };

export interface LandTargetDeps {
    readonly agents: { readonly entry: (id: string) => PersistedAgent | undefined };
    readonly agentWorktrees: Pick<AgentWorktrees, "attached">;
}

// The target as the registry alone reads it, with no git: what a report's words and a wait's answer are drawn from.
// A parent's checkout counts as there; landTargetOf asks git whether each repo of it is still attached.
export const recordedTargetOf = (agents: LandTargetDeps["agents"], child: IsolatedAgent): LandTarget => {
    const parentId = parentOfActor(child.identity.startedBy);
    const parent = parentId === undefined ? undefined : agents.entry(parentId);
    if (parentId === undefined || parent === undefined || parent.archivedAt !== undefined) {
        return OWN;
    }
    if (parent.placement.kind === "main") {
        return { kind: "main", ruled: false };
    }
    // A runner's checkout is its own, on another machine; the one here is a mirror the runner resets at every turn.
    if (parent.placement.runner !== undefined) {
        return OWN;
    }
    const carried = new Set(parent.placement.repos.map(({ repo }) => repo));
    return child.placement.repos.every(({ repo }) => carried.has(repo)) ? { kind: "parent", parent: parentId } : OWN;
};

export const landTargetOf = async (deps: LandTargetDeps, child: IsolatedAgent): Promise<LandTarget> => {
    const recorded = recordedTargetOf(deps.agents, child);
    if (recorded.kind !== "parent") {
        return recorded;
    }
    for (const { repo } of child.placement.repos) {
        if (!(await deps.agentWorktrees.attached(recorded.parent, repo))) {
            return OWN;
        }
    }
    return recorded;
};

// The parent a land writes into, for the land's own `into`; undefined for the main tree.
export const intoOf = (target: LandTarget): string | undefined => (target.kind === "parent" ? target.parent : undefined);

// What the branch is rebased onto before a turn and before a land. One cut from its parent's checkout follows that
// checkout while the parent can take its work, and stays where it stands once it cannot: rebased onto the main line, it
// would carry the parent's unlanded commits as its own. Every other branch follows the main line.
export type Upstream = { readonly kind: "main" } | { readonly kind: "parent"; readonly parent: string } | { readonly kind: "none" };

export const upstreamOf = (child: Pick<IsolatedAgent, "placement">, target: LandTarget): Upstream => {
    const cutFrom = child.placement.parent;
    if (cutFrom === undefined) {
        return { kind: "main" };
    }
    return target.kind === "parent" && target.parent === cutFrom ? { kind: "parent", parent: cutFrom } : { kind: "none" };
};

// Runs a sync or a land against the checkouts it moves: under the conversation's own land lease, and under its parent's
// too when it writes into or follows the parent's checkout, which the parent's own turn and land and every other child
// landing into it also write. Always its own first, then the parent's, so no two holders ever wait on each other.
export const underLeases = <T>(
    conversations: Pick<ConversationActors, "withLandLease">,
    conversationId: string,
    parent: string | undefined,
    task: () => Promise<T>,
): Promise<T> => conversations.withLandLease(conversationId, () => (parent === undefined ? task() : conversations.withLandLease(parent, task)));

// The parent checkout an upstream follows, for the lease it is read and written under.
export const followedParent = (upstream: Upstream): string | undefined => (upstream.kind === "parent" ? upstream.parent : undefined);
