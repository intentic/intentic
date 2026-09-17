import { sleep } from "@intentic/base/async";
import { type AgentTurn, type Rule, type RuleBuiltin, verifyNudgePrompt } from "@intentic/sandbox-contract";
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

// Delivers the turn.ending follow-up on the runtimes with no Stop hook: the built-ins read off the frame ledgers, and
// what the daemon's own run of the command rules found.
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
const builtinRule = (rules: readonly Rule[], name: RuleBuiltin, paths: readonly string[], draw: number): Rule | undefined =>
    rules.find(
        (rule) =>
            rule.moment === "turn.ending" &&
            rule.action.kind === "builtin" &&
            rule.action.name === name &&
            conditionHolds(rule.when, { paths, draw }),
    );

export interface VerifyNudge {
    readonly conversationId: string;
/* The turn that just ended. */
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
    // What the turn.ending command rules found when the daemon ran them after the turn (rules/turn-ending.ts
    // commandRuleFindings), each already worded for the model; absent or empty when they passed or did not run.
    readonly findings?: readonly string[] | undefined;
}

// One follow-up carries every standing ask: two rules is two things to say, not two turns to spend. Every path the turn
// edited, prose included, is one `facts` set per builtin, so a glob can't mean two things; one draw per turn is
// shared by every sampled rule standing here, as the hook path draws once per turn.
const asksOf = async (nudge: VerifyNudge): Promise<{ readonly rule: Rule; readonly message: string }[]> => {
    const paths = nudge.ledger.edited().map((path) => workspaceRelative(path, nudge.cwd));
    const draw = Math.random();
    const asks: { readonly rule: Rule; readonly message: string }[] = [];
    const verify = builtinRule(nudge.rules, "verify-edits", paths, draw);
    if (verify !== undefined) {
        const message = await verifyEditsMessage(nudge.ledger, nudge.isolation);
        if (message !== undefined) {
            asks.push({ rule: verify, message });
        }
    }
    const viewing = nudge.view === undefined ? undefined : builtinRule(nudge.rules, "verify-ui-edits", paths, draw);
    if (viewing !== undefined && nudge.view !== undefined) {
        const message = verifyUiEditsMessage(nudge.view);
        if (message !== undefined) {
            asks.push({ rule: viewing, message });
        }
    }
    const tests = nudge.tests === undefined ? undefined : builtinRule(nudge.rules, "verify-tests", paths, draw);
    if (tests !== undefined && nudge.tests !== undefined) {
        const message = await nudge.tests();
        if (message !== undefined) {
            asks.push({ rule: tests, message });
        }
    }
    return asks;
};

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
    const asks = await asksOf(nudge);
    const findings = nudge.findings ?? [];
    if (asks.length === 0 && findings.length === 0) {
        return undefined;
    }
    // A failed check first: it is the thing the follow-up must repair, the asks are what it must then show. Composed
    // through the contract's opening, since the chat recognises a nudge by it and draws it as the app's errand rather
    // than as words the user typed.
    const message = verifyNudgePrompt([...findings, ...asks.map((ask) => ask.message)]);
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
/* THE NUDGED TURN, WHOLE (agent/run/turn/turn-seed.ts): same provider, same model, same reasoning, same persona, same job. */
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
