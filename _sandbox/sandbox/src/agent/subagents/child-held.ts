import { parentOfActor } from "../../auth/principal.js";
import type { Services } from "../../composition.js";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import { landByHandLeased, type SettleDeps, settleByHand } from "../../conversations/land/land-by-hand.js";
import { landTargetOf } from "../../conversations/land/land-target.js";
import { isIsolated, type PersistedAgent } from "../../conversations/registry/agents-store.js";
import { mergeOutcome } from "./child-listing.js";
import type { ChildActionResult, ChildParent } from "./children.js";
import { ranInProcess } from "./subagents.js";

// WHAT BECOMES OF A CHILD'S WORK HELD OFF ITS PARENT'S CHECKOUT. A child whose land clashed with its parent's edits keeps
// its work on its branch, and its card reads `conflict` until something settles it. The parent has two doors here: `merge`
// brings the work in with conflict markers to resolve, and `settle` says it already brought it in some other way.
//
// `settle` exists because a parent that brings held work in by hand (a patch applied with `git apply -3`, a fork porting
// it onto files that moved) leaves nothing the sandbox can recognise by content once the work was adapted (land/standing.ts
// absorbedIn), so the child kept calling the owner after the parent itself had landed. On 2026-10-20 an orchestrator
// hand-applied two held children, kept a third back on purpose, and landed: its card stood in Attention with "3 need you"
// over work two thirds of which was already in main. The parent is the one that knows, so it says so, through the same
// record the owner's "Already merged" press writes (land-by-hand.ts settleByHand): the child files as landed, nothing is
// written into any tree, and its branch keeps every commit. What a turn leaves held is said back to it once as the turn
// ends (held-children-close.ts), so a child kept back on purpose is one the parent's report names.

type Actors = Pick<ConversationActors, "holdings">;

// Why an id reaches no child of this parent. Both kinds are listed alike (`list`), so an id naming a subagent its own
// runtime ran in-process is told apart from one naming nothing: it is this conversation's, and a service call cannot
// reach it.
export const noSuchChild = (services: { readonly conversations: Actors }, parent: ChildParent, childId: string): ChildActionResult =>
    ranInProcess(services.conversations, parent.conversationId, childId)
        ? {
              ok: false,
              message:
                  "That subagent ran in-process, inside this conversation's own turn: it has no conversation of its own to message, answer or cancel. Only the turn that started it reaches it, through its runtime's own tools.",
          }
        : { ok: false, message: "No such child of this conversation. `list` shows yours." };

// What reading and settling a child's held work needs: the registry's records and land standing, which turns run, and
// the land lease settleByHand writes under.
export type HeldWorkDeps = SettleDeps & {
    readonly agents: Pick<Services["agents"], "ids" | "entry" | "standingOf" | "recordLanded">;
    readonly conversations: Pick<Services["conversations"], "running" | "holdings" | "withLandLease">;
};

const ownedBy = (entry: Pick<PersistedAgent, "identity"> | undefined, parentId: string): boolean =>
    entry !== undefined && parentOfActor(entry.identity.startedBy) === parentId;

// Held: a land that clashed left work on its branch nothing has taken since (land/standing.ts), and no turn of its runs.
const heldNow = (services: HeldWorkDeps, id: string): boolean => services.agents.standingOf(id) === "conflict" && !services.conversations.running(id);

/**
 * Brings a child's work into its parent's own checkout, leaving conflict markers where it clashes with the parent's
 * edits for the parent to resolve: the door a report or `wait` names when a child's land was held off the parent's tree,
 * as a runtime's worktree subagent hands its branch back for the parent to merge. Only the parent that started it may,
 * read off the registry so it outlives a restart, and only for a child whose work goes where the parent works.
 */
export const mergeChild = async (services: Services, parent: ChildParent, childId: string): Promise<ChildActionResult> => {
    const entry = services.agents.entry(childId);
    if (entry === undefined || !isIsolated(entry) || !ownedBy(entry, parent.conversationId)) {
        return noSuchChild(services, parent, childId);
    }
    if (services.conversations.running(childId)) {
        return { ok: false, message: "It is still working: wait for it to finish, then merge what it did." };
    }
    const target = await landTargetOf(services, entry);
    if (target.kind === "main" && target.ruled) {
        return {
            ok: false,
            message:
                "Your checkout cannot take its work (you run on another machine, or it carries a repo you do not), so it lands the way any agent's does.",
        };
    }
    const result = await landByHandLeased(services, entry, "merge", "outstanding");
    return mergeOutcome(result, target.kind === "parent" ? "your checkout" : "the main tree", childId);
};

/** Records a held child's work as already brought in by its parent; refused for anyone else's child, a running one, and work nothing holds. */
export const settleHeldChild = async (services: HeldWorkDeps, parent: ChildParent, childId: string): Promise<ChildActionResult> => {
    const entry = services.agents.entry(childId);
    if (entry === undefined || !isIsolated(entry) || !ownedBy(entry, parent.conversationId)) {
        return noSuchChild(services, parent, childId);
    }
    if (services.conversations.running(childId)) {
        return { ok: false, message: "It is still working: wait for it to finish, then say what became of its work." };
    }
    if (!heldNow(services, childId)) {
        return { ok: true, note: "Nothing of it is held: its work already went where it was headed, or it made none. Nothing was recorded." };
    }
    const answer = await settleByHand(services, childId);
    if (!answer.settled) {
        return { ok: false, message: "Nothing was recorded: its branch holds nothing the record does not already count." };
    }
    services.logger.info({ parent: parent.conversationId, child: childId }, "subagents: a parent recorded a held child's work as brought in by hand");
    return {
        ok: true,
        note: "Recorded as brought in: it files as landed and no longer calls the owner. Nothing was written into any tree, and its branch keeps every commit.",
    };
};

/** One child of a parent whose work a clash still holds on its branch. */
export interface HeldChild {
    readonly id: string;
    readonly title: string | undefined;
}

/** The parent's children whose work is still held, in the registry's order; an archived one is the owner's filing, not news. */
export const heldChildrenOf = (services: HeldWorkDeps, parentId: string): HeldChild[] =>
    services.agents
        .ids()
        .map((id) => services.agents.entry(id))
        .filter((entry): entry is PersistedAgent => entry !== undefined && ownedBy(entry, parentId) && entry.archivedAt === undefined && heldNow(services, entry.id))
        .map((entry) => ({ id: entry.id, title: entry.social.title?.text }));

/** The settle door's description, the same on every runtime that mounts it (the subagents MCP server, Cursor's tools). */
export const SETTLE_WORDS =
    "Record that a subagent's work, held on its branch because it clashed with your edits, is already in your checkout: " +
    "you brought it in yourself (a patch you applied, changes you ported or adapted by hand) instead of with merge. Its " +
    "card then files as landed rather than calling the owner about a land conflict; nothing is written, and its branch " +
    "keeps every commit. Only for work that really is in: one you are keeping back on purpose stays held, and your report says why.";
