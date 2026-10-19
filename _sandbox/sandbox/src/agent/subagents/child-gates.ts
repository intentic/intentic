import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import { type Holding, liveRunOf } from "../../conversations/actor/conversation-holdings.js";
import type { Services } from "../../composition.js";
import { childSpawn } from "../../guard/actions.js";
import { guard } from "../../guard/guard.js";
import { conversationTaintSource } from "../../guard/turn-taint.js";
import { opt } from "../../opt.js";
import { admitMove, type ChildGate, type ChildMoveKind, PASS } from "./child-admission.js";
import { spentAsked } from "./child-listing.js";
import { resultSchemaFault } from "./child-result.js";
import type { ChildRecord, ChildSpawnSpec, PendingChildCard } from "./children.js";

// What may stop a parent's move on its children before anything is spent on it (child-admission.ts runs the list): the
// owner's action rules and the taint floor, the grant they gave for the rest of a turn, the delegation depth, a spent
// model, a result schema out of bounds, and the child's own state (not started yet, mid-turn, parked on a card that is not
// the parent's to answer). children.ts makes the moves.

// Where a parent's grants are held: each conversation's actor.
type Actors = Pick<ConversationActors, "holdings">;

// The owner's "for the rest of this turn" on a child-agent card: the parent's run it was given in, so it lapses with that
// turn, and the providers it covers. Held by the parent under its own id.
export const TURN_GRANTS: Holding<{ readonly run: string; readonly providers: readonly string[] }> = { name: "child move grants" };

// What the owner's rules and the taint floor say of a move before anybody is asked.
export type MoveVerdict =
    { readonly effect: "allow" } | { readonly effect: "deny"; readonly message: string } | { readonly effect: "hold"; readonly reason: string };

// Whether the owner already allowed held moves on this provider for the rest of the parent's live turn.
const turnAllows = (actors: Actors, parent: string, provider: string): boolean => {
    const grant = actors.holdings(TURN_GRANTS).get(parent);
    return grant !== undefined && grant.run === liveRunOf(actors, parent)?.id && grant.providers.includes(provider);
};

// The owner's "for the rest of this turn": this provider joins what the parent's run may do without asking again.
export const grantTurn = (actors: Actors, parent: string, run: string, provider: string): void => {
    const grant = actors.holdings(TURN_GRANTS).get(parent);
    const providers = grant?.run === run ? grant.providers : [];
    actors.holdings(TURN_GRANTS).hold(parent, parent, { run, providers: [...new Set([...providers, provider])] });
};

// Consulted before every supervisor mutation (spawn, send, answer): the owner's action rules plus the taint floor. A hold
// the owner already allowed for the rest of this turn lets the move through.
const judgeMove = async (services: Services, parent: string, provider: string): Promise<MoveVerdict> => {
    const settings = await services.sandboxSettings.get();
    const verdict = guard(childSpawn, { provider, rules: settings.actionRules, ...opt("outsideSource", conversationTaintSource(parent)) });
    if (verdict.effect === "deny") {
        return { effect: "deny", message: `Refused: ${verdict.reason}.` };
    }
    return verdict.effect === "hold" && !turnAllows(services.conversations, parent, provider)
        ? { effect: "hold", reason: verdict.reason }
        : { effect: "allow" };
};

// A provider the owner's rules refuse stays refused when it was picked on the card: the card overrides the agent's
// choice, never the rulebook. A hold is already answered, since the owner is the one who picked it.
export const refusedByRules = async (services: Services, provider: string): Promise<string | undefined> => {
    const settings = await services.sandboxSettings.get();
    const verdict = guard(childSpawn, { provider, rules: settings.actionRules });
    return verdict.effect === "deny" ? `Refused: ${verdict.reason}.` : undefined;
};

// Why a message cannot go to the child yet, whatever the owner's rules say; undefined when it can.
export const notYet = (kid: ChildRecord): string | undefined => {
    if (kid.held === "lane") {
        return "It has not started: it waits for a sibling on its provider to be answered first, or for a seat on it to free. Wait for it, then send again.";
    }
    if (kid.held === "seat") {
        return "It has not started: it waits for one of your running children to end, since you are at the most that may run at once. Wait for it, then send again.";
    }
    if (kid.held === "start") {
        return "It has not started: the owner has not allowed its start yet. Wait for it, then send again.";
    }
    if (kid.held === "message") {
        return "Your last message to it still waits for the owner's approval: wait for that, then send again.";
    }
    if (kid.queued) {
        return "It is waiting for memory and has not started: wait for it, then send again.";
    }
    return kid.behind ? "Your last message is still waiting for the turn already running on it to end: wait for it, then send again." : undefined;
};

// Why a child cannot move now; undefined when it can. Between turns only: a turn under way stays where it runs.
export const unmovable = (kid: ChildRecord): string | undefined =>
    kid.running
        ? "It is mid-turn: a child moves between turns only. Cancel it (its work stays in its worktree), then send again naming the provider and model."
        : notYet(kid);

// Why the child's parked card cannot take the parent's answer; undefined when it can. A permission hold or plan approval
// is the owner's consent alone: a parent approving those would be a model approving its own actions.
export const unanswerableWhy = (pending: PendingChildCard | undefined): string | undefined => {
    if (pending === undefined) {
        return "It is not waiting on anything right now.";
    }
    if (pending.kind === "question") {
        return undefined;
    }
    return pending.kind === "permission"
        ? "It is waiting on a PERMISSION, which is the owner's consent to give, not a parent's. The owner answers it in their chat."
        : "It is waiting on PLAN approval, which is the owner's consent to give, not a parent's. The owner answers it in their chat.";
};

// What every gate reads of a move: the daemon, the parent making it, where it goes (the spec a start or move runs on), and
// for a move on an existing child, its record.
interface MoveContext {
    readonly services: Services;
    readonly parent: string;
    readonly spec: ChildSpawnSpec;
    readonly kid?: ChildRecord;
    // For a spawn: how deep the child would sit, and the deepest the owner allows.
    readonly depth?: { readonly at: number; readonly most: number };
    // For an answer: the card the child is parked on.
    readonly pending?: PendingChildCard | undefined;
}

// A result schema outside the subset is refused before anything is spent on it (child-result.ts).
const schemaGate: ChildGate<MoveContext> = {
    name: "schema",
    judge: ({ spec }) => {
        const fault = spec.result === undefined ? undefined : resultSchemaFault(spec.result.schema);
        return fault === undefined ? PASS : { refuse: fault };
    },
};

const depthGate: ChildGate<MoveContext> = {
    name: "depth",
    judge: ({ depth }) =>
        depth === undefined || depth.at <= depth.most
            ? PASS
            : { refuse: `Spawn depth ${depth.most} reached: this agent is itself a spawned subagent and may not go deeper.` },
};

// A model the records measure as spent is refused before a seat is taken, and before anybody is asked.
const spentGate: ChildGate<MoveContext> = {
    name: "spent",
    judge: async ({ services, spec }) => {
        const spent = await spentAsked(services, spec);
        return spent === undefined ? PASS : { refuse: spent };
    },
};

// The owner's action rules and the taint floor: allowed, refused, or held for the owner's card.
const rulesGate: ChildGate<MoveContext> = {
    name: "rules",
    judge: async ({ services, parent, spec }) => {
        const verdict = await judgeMove(services, parent, spec.provider);
        if (verdict.effect === "deny") {
            return { refuse: verdict.message };
        }
        return verdict.effect === "hold" ? { hold: verdict.reason } : PASS;
    },
};

// A child mid-turn, or one whose start still waits, moves to another provider only between turns.
const movableGate: ChildGate<MoveContext> = {
    name: "child-state",
    judge: ({ kid }) => {
        const why = kid === undefined ? undefined : unmovable(kid);
        return why === undefined ? PASS : { refuse: why };
    },
};

// Only a question is the parent's to answer; a permission or a plan is the owner's consent.
const answerableGate: ChildGate<MoveContext> = {
    name: "child-state",
    judge: ({ pending }) => {
        const why = unanswerableWhy(pending);
        return why === undefined ? PASS : { refuse: why };
    },
};

// Each move's gates, in order.
const GATES = {
    spawn: [schemaGate, depthGate, spentGate, rulesGate],
    send: [rulesGate],
    answer: [answerableGate, rulesGate],
    rehome: [movableGate, spentGate, rulesGate],
    fallback: [spentGate, rulesGate],
} as const satisfies Record<ChildMoveKind, readonly ChildGate<MoveContext>[]>;

export const admit = (kind: ChildMoveKind, context: MoveContext, child?: string): ReturnType<typeof admitMove> =>
    admitMove(GATES[kind], context, { kind, parent: context.parent, ...opt("child", child) }, context.services.logger);

