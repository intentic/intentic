import type { AgentTurn, TurnNote } from "@intentic/sandbox-contract";
import { compactedSinceLastTurn, type Composition } from "../../agents/registry/agents-store.js";
import type { ConversationWorktree } from "../../agents/worktrees/worktrees.js";
import type { Services } from "../../composition.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
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

// Brings the checkout to what the conversation carries, for both the local turn and the runner's mirror. The opening
// turn decides and records the composition; later turns reconcile the checkout to it.
export const ensureComposedWorktree = async (
    services: Services,
    input: AgentTurn,
    conversationId: string,
    base: readonly { repo: string; base: string }[] | undefined,
    namespaced: boolean,
): Promise<ConversationWorktree> => {
    const recorded = services.agents.entry(conversationId)?.repos ?? [];
    const opening = recorded.length === 0;
    const composition = opening ? await decideComposition(services, input) : services.agents.entry(conversationId)?.composition;
    const worktree = await services.agentWorktrees.ensure(conversationId, recorded, base, namespaced, composition?.repos);
    if (opening || !sameRepos(recorded, worktree.repos)) {
        await services.agents.recordWorktree(conversationId, worktree.repos, composition);
    }
    return worktree;
};

// Builds the note only for turns that owe it: the opening turn and the one after a compaction, when history can't carry
// it. Reads the just-recorded composition, so the note matches the tree the turn opens on.
export const contextNoteIfDue = (
    services: Services,
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
export const contextNoteFor = async (services: Services, conversationId: string): Promise<TurnNote | undefined> => {
    const composition = services.agents.entry(conversationId)?.composition;
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
