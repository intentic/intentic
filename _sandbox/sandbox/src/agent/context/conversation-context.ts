import type { AgentTurn, RepoBase, TurnNote } from "@intentic/sandbox-contract";
import { landTargetOf } from "../../conversations/land/land-target.js";
import { compactedSinceLastTurn, type Composition, isIsolated, type PersistedAgent, worktreeOf } from "../../conversations/registry/agents-store.js";
import type { ConversationWorktree } from "../../conversations/worktrees/worktrees.js";
import type { Services } from "../../composition.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
import { conversationFence } from "../../areas/area-scope.js";
import { checkpointWorktree } from "../checkpoints/checkpoint-worktree.js";
import { contextNote } from "./context-note.js";

// Composition is decided once, by the route, on the turn that creates the conversation's worktrees — the one moment it
// can still change what's checked out. No card, or none naming context, means everything. Static: the pick is a list on
// the card, not a model's reading of the message, so every chat on one card opens on the same tree. Described on the
// turn's preamble from the same record the route wrote, so the note and the tree can't disagree.

// What the conversation should carry, or undefined for everything. A named-but-missing card is undefined too:
// turnPersona already denies that turn accounts and tools, so the tree may as well be the whole one.
export const decideComposition = async (services: Services, input: AgentTurn): Promise<Composition | undefined> => {
    if (input.actsAs === undefined) {
        return undefined;
    }
    const card = await services.personas.get(input.actsAs);
    if (card?.context === undefined) {
        return undefined;
    }
    return { persona: card.id, repos: [...card.context.repos] };
};

// Whether two records name the same repos; bases move (pre-turn rebase) without the composition changing, so this is
// what decides a join/leave happened.
export const sameRepos = (before: readonly { readonly repo: string }[], after: readonly { readonly repo: string }[]): boolean =>
    before.length === after.length && before.every(({ repo }, index) => after[index]?.repo === repo);

// A spawned child's first checkout, cut from its parent's current work: the parent's remainder committed first, as a
// checkpoint is, and each of the child's repos pinned to the parent's commit, so the child reads what the parent reads,
// as the parent's in-process subagents do, and its work goes back onto the tree it was cut from (land-target.ts).
// Undefined for a conversation of its own, and for a child whose parent's checkout cannot take its work.
const parentCut = async (services: Services, entry: PersistedAgent | undefined, childId: string): Promise<{ parent: string; base: RepoBase[] } | undefined> => {
    if (entry === undefined || !isIsolated(entry)) {
        return undefined;
    }
    const target = await landTargetOf(services, entry);
    if (target.kind !== "parent") {
        return undefined;
    }
    const repos = worktreeOf(services.agents.entry(target.parent))?.repos ?? [];
    const base = await services.conversations.withLandLease(target.parent, () =>
        checkpointWorktree(services, target.parent, repos, `Agent: before starting ${childId}`),
    );
    // A repo the parent's checkout could not be read in is one the child could not land back into.
    return repos.length > 0 && base.length === repos.length ? { parent: target.parent, base } : undefined;
};

// Brings the checkout to what the conversation carries, for both the local turn and the runner's mirror. The opening
// turn decides and records the composition; later turns reconcile the checkout to it. A local spawned child with no base
// of its own opens on its parent's current work (`fromParent`); a runner's child opens on the main line, since the runner
// rebases the branch onto its own copy of it.
export const ensureComposedWorktree = async (
    services: Services,
    input: AgentTurn,
    conversationId: string,
    base: readonly { repo: string; base: string }[] | undefined,
    namespaced: boolean,
    fromParent = false,
): Promise<ConversationWorktree> => {
    const entry = services.agents.entry(conversationId);
    const recorded = worktreeOf(entry)?.repos ?? [];
    const opening = recorded.length === 0;
    const composition = opening ? await decideComposition(services, input) : worktreeOf(entry)?.composition;
    const cut = opening && fromParent && base === undefined ? await parentCut(services, entry, conversationId) : undefined;
    // The conversation's own fence, from the areas its starter held. Resolved here rather than latched as folders,
    // so editing an area narrows an existing conversation's checkout on its next turn.
    const fence = conversationFence(await services.areas.list(), entry?.identity);
    const worktree = await services.agentWorktrees.ensure(conversationId, recorded, cut?.base ?? base, namespaced, composition?.repos, fence);
    if (opening || !sameRepos(recorded, worktree.repos)) {
        await services.agents.recordWorktree(conversationId, worktree.repos, composition, cut?.parent);
    }
    return worktree;
};

// Builds the note only for turns that owe it: the opening turn and the one after a compaction, when history can't carry
// it. Reads the just-recorded composition, so the note matches the tree the turn opens on.
export const contextNoteIfDue = (
    services: Pick<Services, "agents" | "workspace" | "personas">,
    input: AgentTurn,
    entry: { readonly compactedTurn?: number | undefined } | undefined,
    conversationTurns: number,
): Promise<TurnNote | undefined> => {
    if (input.conversationId === undefined || (conversationTurns !== 0 && !compactedSinceLastTurn(entry, conversationTurns))) {
        return Promise.resolve(undefined);
    }
    return contextNoteFor(services, input.conversationId);
};

// The preamble's account of the composition; undefined when the conversation carries everything (nothing to tell). The
// card is re-read for its label only — repos come from the record, so an edited card changes nothing here.
export const contextNoteFor = async (services: Pick<Services, "agents" | "workspace" | "personas">, conversationId: string): Promise<TurnNote | undefined> => {
    const composition = worktreeOf(services.agents.entry(conversationId))?.composition;
    if (composition === undefined) {
        return undefined;
    }
    const live = await discoverRepos(services.workspace.root);
    const card = composition.persona === undefined ? undefined : await services.personas.get(composition.persona);
    return contextNote({
        persona: card?.label ?? composition.persona,
        carried: composition.repos.filter((repo) => live.includes(repo)),
        absent: live.filter((repo) => !composition.repos.includes(repo)),
        missing: composition.repos.filter((repo) => !live.includes(repo)),
    });
};
