import { sleep } from "@intentic/base/async";
import type { AgentTurn, Rule, RuleBuiltin } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { WakeFn } from "../../automations/scheduler.js";
import type { Services } from "../../composition.js";
import type { IsolationPlan } from "../../agents/worktrees/isolation.js";
import { conditionHolds } from "../../rules/rules.js";
import { workspaceRelative } from "../../rules/turn-ending.js";
import { type VerificationLedger, verifyEditsMessage } from "./agent-verification.js";
import { type ViewLedger, verifyUiEditsMessage } from "./agent-viewing.js";
import { startConversationTurn } from "../run/turn/turn-resume.js";
import { seedFields } from "../run/turn/turn-seed.js";

// Delivers the `verify-edits` follow-up on the five runtimes with no Stop hook: what was missing was a ledger, not the
// follow-up itself. Sends a fresh daemon-started turn rather than a steer, since a steer queue can vanish mid-unwind;
// Claude keeps its cheaper in-turn hook. Spends a turn on the user's behalf, so it is gated: the rule must stand, its
// conditions must hold, the work unproven, and a nudge never answers a nudge.

// Delivery pacing: a nudge fails only while another turn is live, and turns end, so a bounded retry converges.
const RETRY_MS = 5_000;
const ATTEMPTS = 12;

export interface VerifyNudgeRuntime {
    readonly logger: Logger;
    readonly start: (turn: AgentTurn & { conversationId: string }) => Promise<boolean>;
    readonly sessionIdOf: (conversationId: string) => string | undefined;
}

let runtime: VerifyNudgeRuntime | undefined;

// Conversations with a nudge in flight; the loop guard, cleared on the next ask, one turn un-nudged at most.
const pending = new Set<string>();

// The rule the owner stood here, if any, re-checked against `moment` even though the planner filtered it, the same belt
// the hook path keeps. Only builtins that read a record or the tree; instruct/command rules are the hook path's to
// deliver.
const builtinRule = (rules: readonly Rule[], name: RuleBuiltin, paths: readonly string[]): Rule | undefined =>
    rules.find(
        (rule) =>
            rule.moment === "turn.ending" && rule.action.kind === "builtin" && rule.action.name === name && conditionHolds(rule.when, { paths }),
    );

export interface VerifyNudge {
    readonly conversationId: string;
    /* The turn that just ended. Its whole identity is copied onto the follow-up (agent/run/turn/turn-seed.ts) —
     * provider, harness, account, model, effort, reasoning, speed, persona, posture and job — because the
     * follow-up has to run WHERE the work ran, or it is asking a different agent about somebody else's edits.
     *
     * "Whole" is load-bearing and was not true: this copied five of those and dropped `thinking`, `fast` and
     * `actsAs`, so a nudge on a reasoning-off turn came back reasoning, and a nudge on a persona's turn came
     * back as nobody — with that card's toolbox and signed-in accounts gone, in a follow-up whose entire job is
     * to go and run something. */
    readonly seed: AgentTurn;
    readonly rules: readonly Rule[];
    readonly ledger: VerificationLedger;
    // What the turn drew against whether it looked; optional, so a caller with no such ledger can't fire that rule.
    readonly view?: ViewLedger | undefined;
    readonly isolation?: IsolationPlan | undefined;
    // The turn's own tree, so a rule spelled `src/**` matches paths the way the owner spells them.
    readonly cwd?: string | undefined;
    readonly onFired?: ((rule: Rule) => void) | undefined;
    // The verify-tests built-in's answer, bound to the turn's tree; optional for the same reason `view` is.
    readonly tests?: (() => Promise<string | undefined>) | undefined;
}

// Decides, then delivers; returns the message sent, for the tests. Called from streamAgent's `finally` and never
// awaited there, so the turn settles regardless of this bookkeeping.
export const nudgeUnverifiedWork = async (nudge: VerifyNudge): Promise<string | undefined> => {
    const live = runtime;
    if (live === undefined || nudge.rules.length === 0) {
        return undefined;
    }
    // A nudge answering a nudge is the loop this guard exists for; cleared here so the next turn is free again.
    if (pending.delete(nudge.conversationId)) {
        return undefined;
    }
    // Every path the turn edited, prose included: one `facts` set per builtin, so a glob can't mean two things.
    const paths = nudge.ledger.edited().map((path) => workspaceRelative(path, nudge.cwd));
    // One follow-up carries every standing ask: two rules is two things to say, not two turns to spend.
    const asks: { readonly rule: Rule; readonly message: string }[] = [];
    const verify = builtinRule(nudge.rules, "verify-edits", paths);
    if (verify !== undefined) {
        const message = await verifyEditsMessage(nudge.ledger, nudge.isolation);
        if (message !== undefined) {
            asks.push({ rule: verify, message });
        }
    }
    const viewing = nudge.view === undefined ? undefined : builtinRule(nudge.rules, "verify-ui-edits", paths);
    if (viewing !== undefined && nudge.view !== undefined) {
        const message = verifyUiEditsMessage(nudge.view);
        if (message !== undefined) {
            asks.push({ rule: viewing, message });
        }
    }
    const tests = nudge.tests === undefined ? undefined : builtinRule(nudge.rules, "verify-tests", paths);
    if (tests !== undefined && nudge.tests !== undefined) {
        const message = await nudge.tests();
        if (message !== undefined) {
            asks.push({ rule: tests, message });
        }
    }
    if (asks.length === 0) {
        return undefined;
    }
    const message = asks.map((ask) => ask.message).join("\n\n");
    pending.add(nudge.conversationId);
    for (const ask of asks) {
        nudge.onFired?.(ask.rule);
    }
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
                /* THE NUDGED TURN, WHOLE (agent/run/turn/turn-seed.ts): same provider, same model, same reasoning,
                 * same persona, same job. This module's standing rule is that a follow-up on a different model
                 * is a different agent asked about somebody else's edits, and it meets them cold — the whole
                 * value of resuming the session above is a context the provider has already cached.
                 *
                 * It used to fall back to a `verify-nudge` model role when the nudged turn named no model, which
                 * could not happen and would have been wrong if it had: the fill step that reads a role only
                 * looks at a turn that is unattended and names neither model nor provider (turn-resume.ts), so
                 * the row bound for nothing while advertising exactly the model switch this rule forbids. */
                ...seedFields(seed),
            });
            if (started) {
                live.logger.info({ conversationId }, "verify nudge: follow-up turn started on unverified work");
                return;
            }
        } catch (error) {
            live.logger.warn({ err: error, conversationId }, "verify nudge: follow-up failed to start, retrying");
        }
        await sleep(RETRY_MS, { unref: true });
    }
    // Never landed, so the conversation is released rather than held against a follow-up that isn't coming.
    pending.delete(conversationId);
    live.logger.warn({ conversationId }, "verify nudge: could not start a follow-up, the turn stands unverified");
};

// The runtime with its seams bound, exported so tests can stand fakes into every slot.
export const startVerifyNudgeRuntime = (live: VerifyNudgeRuntime): (() => void) => {
    runtime = live;
    return () => {
        pending.clear();
        runtime = undefined;
    };
};

// Boot wiring: the same detached-turn door every daemon-started turn uses, which journals the wake so a daemon death
// between start and first frame re-runs it.
export const startVerifyNudges = (services: Services, wake: WakeFn): (() => void) =>
    startVerifyNudgeRuntime({
        logger: services.logger,
        start: async (turn) => (await startConversationTurn(services, wake, turn)) !== undefined,
        sessionIdOf: (conversationId) => services.agents.sessionIdOf(conversationId),
    });
