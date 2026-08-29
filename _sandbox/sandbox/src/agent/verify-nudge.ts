import type { AgentTurn, Rule } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import type { IsolationPlan } from "../agents/isolation.js";
import { conditionHolds } from "../rules/rules.js";
import { workspaceRelative } from "../rules/turn-ending.js";
import { type VerificationLedger, verifyEditsMessage } from "./agent-verification.js";
import { startConversationTurn } from "./turn-resume.js";

/* THE PROOF FOLLOW-UP, ON THE FIVE RUNTIMES THAT COULD NEVER HAVE IT.
 *
 * `verify-edits` is a rule the owner stands at `turn.ending`: a turn that changed code and ran no check after
 * its last edit gets one bounded follow-up naming the checks this workspace actually has, and the turn carries
 * on instead of finishing on unverified work. It reached the model through the Claude Agent SDK's Stop hook,
 * which is to say it existed on ONE of this daemon's six runtimes. A Codex, Grok, Gemini, Cursor, Pi or ACP
 * turn ended silently with the rule standing and doing nothing, and the owner had no way to know: the rule sat
 * in the list looking armed.
 *
 * WHAT WAS MISSING WAS NEVER THE FOLLOW-UP, IT WAS THE LEDGER. Nothing outside the Claude arm knew which files
 * a turn had edited or which of its commands were checks. The frame-fed ledger (agent-verification.ts,
 * createFrameLedger) closes exactly that: every runtime normalizes its stream into one `tool_call` vocabulary,
 * so the same verdict is now computable for all of them, and this module is only the delivery.
 *
 * A FRESH TURN, NOT A STEER, and deliberately, though one of the five (Pi) has a steer queue. The decision is
 * made in streamAgent's `finally`, with the turn already unwinding and its steering queue on its way to
 * closed; a message pushed into that is a message that may simply vanish, which is the one failure mode a
 * mechanism about unverified work must not have. So the nudge always goes down the ordinary daemon-started
 * turn road (turn-resume.ts), resuming the conversation's provider session so the agent picks its own thread
 * back up rather than meeting the work cold.
 *
 * THE CLAUDE ARM KEEPS ITS HOOKS. An in-turn Stop follow-up costs no new session and no re-read of the
 * context, so it is strictly better where it exists; this is the fallback for where it does not, and the two
 * are kept apart by `capabilitiesOf(...).rulebook === "hooks"` at the call site. Nothing is nudged twice.
 *
 * IT SPENDS A TURN ON THE USER'S BEHALF, which is why the guards are what they are: the rule has to be
 * standing (nothing here is on by default), its conditions have to hold against the files this turn really
 * touched, the work has to be genuinely unproven, the turn has to have ENDED WELL, and a nudge never answers
 * a nudge. */

// Delivery pacing. A nudge can only fail to land while another turn is live on the conversation, and turns
// end, so a short patient retry converges. Bounded tightly on purpose: a follow-up that arrives ten minutes
// and two user messages later is about work nobody is looking at any more, and dropping it beats that.
const RETRY_MS = 5_000;
const ATTEMPTS = 12;

export interface VerifyNudgeRuntime {
    readonly logger: Logger;
    readonly start: (turn: AgentTurn & { conversationId: string }) => Promise<boolean>;
    readonly sessionIdOf: (conversationId: string) => string | undefined;
}

let runtime: VerifyNudgeRuntime | undefined;

/* Conversations with a nudge in flight or freshly delivered. This is the whole loop guard, and it has to
 * exist: the follow-up runs as its own turn, that turn is watched by the same code that decided to send it,
 * and a model that answers the nudge without running anything would otherwise be nudged again, forever.
 *
 * ONE PER TURN, cleared the next time this module is asked about the conversation. Which means a user message
 * that lands between the two is what clears it, and that conversation gets one un-nudged turn. That is the
 * safe direction to be wrong in: the cost of a missed follow-up is a sentence nobody read, and the cost of a
 * loop is an agent spending someone's allowance arguing with itself. */
const pending = new Set<string>();

/* The rule the owner stood here, or none. `moment` is re-checked though the planner already filtered on it,
 * the same belt the hook path keeps: a rule firing at a moment it was not written for is silent and wrong.
 *
 * Only the `verify-edits` builtin. An `instruct` rule's text and a `command` rule's runner are the hook path's
 * to deliver, and a command rule in particular needs the turn's own tmux runner in the turn's own cwd, which
 * no longer exists by the time this runs. */
const verifyRule = (rules: readonly Rule[], paths: readonly string[]): Rule | undefined =>
    rules.find(
        (rule) =>
            rule.moment === "turn.ending" &&
            rule.action.kind === "builtin" &&
            rule.action.name === "verify-edits" &&
            conditionHolds(rule.when, { paths }),
    );

export interface VerifyNudge {
    readonly conversationId: string;
    // The turn that just ended, copied for provider, model, account, effort and posture: the follow-up has to
    // run where the work ran, or it is asking a different agent about somebody else's edits.
    readonly seed: AgentTurn;
    readonly rules: readonly Rule[];
    readonly ledger: VerificationLedger;
    readonly isolation?: IsolationPlan | undefined;
    // The turn's own tree, so a rule written as `src/**` is matched against paths spelled the way the owner
    // spells them (the hook path's rule, kept identical here so the same glob cannot mean two things).
    readonly cwd?: string | undefined;
    readonly onFired?: ((rule: Rule) => void) | undefined;
}

/* Decide, then deliver. Returns the message it sent for the tests; undefined means it said nothing, which is
 * the overwhelmingly common answer and costs a map lookup and a filter.
 *
 * Called from streamAgent's `finally` and never awaited there: the turn must settle whether or not its
 * bookkeeping does, the same contract as every other write at that moment. */
export const nudgeUnverifiedWork = async (nudge: VerifyNudge): Promise<string | undefined> => {
    const live = runtime;
    if (live === undefined || nudge.rules.length === 0) {
        return undefined;
    }
    // A nudge answering a nudge is the loop this guard exists for. Cleared here, so the conversation is free
    // again from the next turn on whatever the follow-up achieved.
    if (pending.delete(nudge.conversationId)) {
        return undefined;
    }
    const paths = nudge.ledger.edited().map((path) => workspaceRelative(path, nudge.cwd));
    const rule = verifyRule(nudge.rules, paths);
    if (rule === undefined) {
        return undefined;
    }
    // The one decision, made by the same function the Stop hook calls: undefined ⇒ nothing was edited, or a
    // check has passed since the last edit, and either way the turn is done.
    const message = await verifyEditsMessage(nudge.ledger, nudge.isolation);
    if (message === undefined) {
        return undefined;
    }
    pending.add(nudge.conversationId);
    nudge.onFired?.(rule);
    void deliver(live, nudge, message).catch((error: unknown) =>
        live.logger.error({ err: error, conversationId: nudge.conversationId }, "verify nudge: delivery crashed"),
    );
    return message;
};

const deliver = async (live: VerifyNudgeRuntime, nudge: VerifyNudge, message: string): Promise<void> => {
    const { conversationId, seed } = nudge;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const sessionId = live.sessionIdOf(conversationId);
        try {
            const started = await live.start({
                prompt: message,
                conversationId,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(seed.agent !== undefined ? { agent: seed.agent } : {}),
                ...(seed.harness !== undefined ? { harness: seed.harness } : {}),
                ...(seed.account !== undefined ? { account: seed.account } : {}),
                ...(seed.model !== undefined ? { model: seed.model } : {}),
                ...(seed.effort !== undefined ? { effort: seed.effort } : {}),
                ...(seed.isolated === true ? { isolated: true } : {}),
                ...(seed.unattended === true ? { unattended: true } : {}),
            });
            if (started) {
                live.logger.info({ conversationId }, "verify nudge: follow-up turn started on unverified work");
                return;
            }
        } catch (error) {
            live.logger.warn({ err: error, conversationId }, "verify nudge: follow-up failed to start, retrying");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, RETRY_MS).unref());
    }
    /* It never landed, so the conversation is released rather than left holding a guard against a follow-up
     * that is not coming. The loss is bounded and said whole: the record of the unverified turn is on the
     * spend ledger either way (UsageTurn.verification), which is the durable half of this. */
    pending.delete(conversationId);
    live.logger.warn({ conversationId }, "verify nudge: could not start a follow-up, the turn stands unverified");
};

// The runtime with its seams bound, exported for the tests, which stand fakes into every slot.
export const startVerifyNudgeRuntime = (live: VerifyNudgeRuntime): (() => void) => {
    runtime = live;
    return () => {
        pending.clear();
        runtime = undefined;
    };
};

// Boot wiring (main.ts): the same detached-turn door every daemon-started turn uses (turn-resume.ts), which
// journals the wake, so even a daemon death between start and first frame re-runs it.
export const startVerifyNudges = (services: Services, wake: WakeFn): (() => void) =>
    startVerifyNudgeRuntime({
        logger: services.logger,
        start: async (turn) => (await startConversationTurn(services, wake, turn)) !== undefined,
        sessionIdOf: (conversationId) => services.agents.sessionIdOf(conversationId),
    });
