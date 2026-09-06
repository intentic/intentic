import type { AgentTurn, TurnNote } from "@intentic/sandbox-contract";
import { compactedSinceLastTurn, type Composition } from "../agents/agents-store.js";
import type { ConversationWorktree } from "../agents/worktrees.js";
import type { Services } from "../composition.js";
import { discoverRepos } from "../workspace/repo-discovery.js";
import { contextNote } from "./context-note.js";

/* A CONVERSATION'S COMPOSITION, decided and described: the two places the daemon reads a persona card's
 * `context` (contract schemas/personas.ts).
 *
 * DECIDED once, by the route, on the turn that creates the conversation's worktrees (agent.routes.ts, right
 * before `ensure`), because that is the one moment the answer can still change what gets checked out. The
 * answer is the card the turn wears, and nothing else: no sandbox-wide default, because the card IS the
 * sandbox's description of a working posture and a context with no card to name it would be a second place to
 * look. A turn wearing no card, or a card that says nothing about its context, carries everything, exactly as
 * before cards could narrow a tree, and that costs nothing: no composition, every repository.
 *
 * STATIC by design. The pick is a list the owner wrote on the card, never a model's reading of the message,
 * so every conversation on one card opens on the same tree. The per-chat decision is WHICH card, which the
 * composer asks agent/persona-router.ts before the first turn.
 *
 * DESCRIBED on the turn's preamble (turn-plan.ts) from the record the route wrote, so the note and the tree
 * cannot disagree: both are read off the same composition, and the repositories it does not carry are the
 * live ones it does not name, computed against the workspace at the moment the note is built. */

/* What the conversation about to be created should carry, or undefined for everything. A card that is named
 * and missing is undefined too: turnPersona already answers that turn with no accounts and no tools, and the
 * tree it cannot use may as well be the whole one. */
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

// Do two records name the same repositories? Bases move (the pre-turn rebase) without the composition changing,
// so this is the comparison that says whether a join or a leave happened and the record has to be rewritten.
export const sameRepos = (before: readonly { readonly repo: string }[], after: readonly { readonly repo: string }[]): boolean =>
    before.length === after.length && before.every(({ repo }, index) => after[index]?.repo === repo);

/* THE CONVERSATION'S CHECKOUT, BROUGHT TO WHAT IT CARRIES: the one call a turn makes for its worktrees, from
 * both arms of the route (agent.routes.ts, the local turn and the runner's mirror), so a card narrows a remote
 * conversation exactly as it narrows one that runs here.
 *
 * On the OPENING turn (no repos recorded yet) the composition is decided and written down with the worktrees it
 * shaped. On every later turn the recorded composition is handed back to `ensure`, which brings the checkout to
 * it: a repo it names that the record lacks joins, one it stopped naming leaves (worktrees.ts). The record is
 * rewritten whenever the set of repos moved, which used to happen only on the opening turn because nothing else
 * could move it. `base` is a snapshot to pin every repo to (a workflow's, a fork's), absent for today's files. */
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

/* The note on the turns that owe it: the opening turn, and the turn after a compaction, the two moments nothing
 * in the session's own history can be relied on to carry it (agents-store.ts compactedSinceLastTurn). A
 * conversationless turn has no record and carries everything. Read off the composition the route recorded
 * moments ago with the worktrees, so the note describes the tree the turn is about to open on. */
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

/* The preamble's account of the composition, or undefined for a conversation that carries everything, which
 * has nothing to be told. One directory walk (repo-discovery.ts) on the turns that send it. The card is read
 * again for its LABEL only; the repositories come off the record, so a card edited since says nothing here. */
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
