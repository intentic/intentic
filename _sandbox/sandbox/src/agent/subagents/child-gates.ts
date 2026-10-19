import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import { type Holding, type LiveRun, liveRunOf } from "../../conversations/actor/conversation-holdings.js";
import type { Services } from "../../composition.js";
import { childSpawn } from "../../guard/actions.js";
import { guard } from "../../guard/guard.js";
import { conversationTaintSource } from "../../guard/turn-taint.js";
import { opt } from "../../opt.js";
import { admitMove, type ChildGate, type ChildMoveKind, PASS } from "./child-admission.js";
import { spentAsked } from "./child-listing.js";
import { resultSchemaFault } from "./child-result.js";
import type { ChildRecord, ChildSpawnSpec, PendingChildCard } from "./children.js";
import type { Caller } from "../../auth/auth.js";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { ChildAgentAsk, ChildRun } from "@intentic/sandbox-contract/events/requests";
import { PROVIDERS } from "@intentic/sandbox-contract/models/agent-catalog";
import { childRunOf, sameChildRun } from "@intentic/sandbox-contract/events/child-run";
import { cardDeps } from "../../conversations/actor/card-deps.js";
import { raiseRequest } from "../../guard/card-offers.js";
import { ALWAYS_LABEL, MOVE_BUTTON, MOVE_TITLE, unansweredWords } from "./child-words.js";
import { CHILDREN } from "./child-records.js";

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
const grantTurn = (actors: Actors, parent: string, run: string, provider: string): void => {
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

// The owner's card for a child move (a start, a send, an answer): raised on the parent's live turn, or followed where
// the turn journal already put it back after a restart.

// Every child-agent card still up, by request id, held by the parent: which run raised it and on which provider, so the
// owner's "for the rest of this turn" on one answers the others it covers.
export const HELD_MOVES: Holding<{ readonly requestId: string; readonly run: string; readonly provider: string }> = { name: "held child moves" };

// Display label for the roster row; a provider absent from PROVIDERS shows as its raw id.
export const labelOf = (provider: AgentProvider): string => PROVIDERS.find((entry) => entry.value === provider)?.label ?? provider;

// A supervisor move let through; `run` is set only when the owner re-pointed a start on the card, and is then the whole
// run to start the child on in place of the agent's.
export type Admission = { readonly ok: true; readonly run?: ChildRun } | { readonly ok: false; readonly message: string };

// The grant answers the cards already up on that provider in that turn as well as the moves still to come: four starts
// held side by side are one decision, not four presses of the same caret.
const releaseHeldMoves = (
    services: Pick<Services, "conversations" | "cards">,
    parent: string,
    run: string,
    provider: string,
    caller: Caller | undefined,
): void => {
    for (const held of services.conversations.holdings(HELD_MOVES).of(parent)) {
        if (held.run === run && held.provider === provider) {
            services.cards.resolve({ kind: "permission", requestId: held.requestId, decision: "always" }, caller);
        }
    }
};

// Raises the card on the parent's live turn and settles with the owner's answer, however long that takes; nobody's call
// waits on it. The two refusals differ because the model's next move differs, and only one is the owner declining.
export const askOwner = async (services: Services, parent: string, run: LiveRun, ask: ChildAgentAsk, reason: string, childId?: string): Promise<Admission> => {
    const { move, provider } = ask;
    const ended = new AbortController();
    void run.waitUntilFinished().then(() => ended.abort());
    let held: string | undefined;
    const settled = raiseRequest(
        cardDeps(services),
        { conversationId: parent, push: (event) => run.push(event) },
        {
            kind: "permission",
            onAbort: { kind: "permission", requestId: "", decision: "deny", feedback: "The turn ended before you answered." },
            raised: (requestId) => {
                // Filed as the card goes up, which is the one moment its id is known before the answer.
                held = requestId;
                const kid = childId === undefined ? undefined : services.conversations.holdings(CHILDREN).get(childId);
                if (kid?.startHold !== undefined) {
                    kid.startHold = { ...kid.startHold, requestId };
                    kid.persist?.();
                }
                services.conversations.holdings(HELD_MOVES).hold(parent, requestId, { requestId, run: run.id, provider });
                return {
                    kind: "permission",
                    requestId,
                    toolName: "agents.spawn",
                    title: `${MOVE_TITLE[move]} on ${labelOf(provider)}?`,
                    displayName: MOVE_BUTTON[move],
                    reason,
                    alwaysLabel: ALWAYS_LABEL,
                    child: ask,
                };
            },
            approves: (answer) => answer.decision !== "deny",
            signal: ended.signal,
        },
    );
    const { decision, reply, caller } = await settled.finally(() => {
        if (held !== undefined) {
            services.conversations.holdings(HELD_MOVES).drop(held);
        }
    });
    switch (decision) {
        case "approved": {
            if (reply.decision === "always") {
                grantTurn(services.conversations, parent, run.id, provider);
                releaseHeldMoves(services, parent, run.id, provider, caller);
            }
            // Only a start can be re-pointed: a child already running keeps the run it was started on (childProfile).
            const picked = move === "spawn" ? reply.child : undefined;
            return picked !== undefined && !sameChildRun(ask, picked) ? { ok: true, run: childRunOf(picked) } : { ok: true };
        }
        case "unanswered":
            return { ok: false, message: unansweredWords(move, reason) };
        case "declined":
            return {
                ok: false,
                message: `The owner declined this. Do not retry: carry on with what you can do without it, and say plainly what you left undone.`,
            };
    }
};

// The turn journal may already have put the original card back. Follow its resolution instead of drawing a second
// card or replacing its waiter, which belongs to the restored parent turn.
export const restoredStartAnswer = async (services: Services, parent: string, run: LiveRun, ask: ChildAgentAsk, requestId: string): Promise<Admission> => {
    services.conversations.holdings(HELD_MOVES).hold(parent, requestId, { requestId, run: run.id, provider: ask.provider });
    try {
        for await (const event of run.frames()) {
            if (event.kind !== "resolved" || event.requestId !== requestId) {
                continue;
            }
            const reply = event.reply;
            if (reply?.kind !== "permission" || reply.decision === "deny") {
                return { ok: false, message: "The owner did not allow this start after the restart. It has not run." };
            }
            if (reply.decision === "always") {
                grantTurn(services.conversations, parent, run.id, ask.provider);
                releaseHeldMoves(services, parent, run.id, ask.provider, undefined);
            }
            return reply.child !== undefined && !sameChildRun(ask, reply.child) ? { ok: true, run: childRunOf(reply.child) } : { ok: true };
        }
        return { ok: false, message: "The parent's restored turn ended before the owner allowed this start. It has not run." };
    } finally {
        services.conversations.holdings(HELD_MOVES).drop(requestId);
    }
};
