import { sleep } from "@intentic/base/async";
import { type AgentTurn, type Rule, type RuleBuiltin, type TurnProfile, verifyNudgePrompt } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { ConversationActors } from "../../agents/actor/conversation-actors.js";
import type { Services } from "../../composition.js";
import type { IsolationPlan } from "../../agents/worktrees/isolation.js";
import { conditionHolds } from "../../rules/rules.js";
import { workspaceRelative } from "../../rules/turn-ending.js";
import { type VerificationLedger, verifyEditsMessage } from "./agent-verification.js";
import { type ViewLedger, verifyUiEditsMessage } from "./agent-viewing.js";

// Delivers the turn.ending follow-up on the runtimes with no Stop hook: the built-ins read off the frame ledgers, and
// what the daemon's own run of the command rules found.
// Claude keeps its cheaper in-turn hook. Spends a turn on the user's behalf, so it is gated: the rule must stand, its
// conditions must hold, the work unproven, and a nudge never answers a nudge.

// Delivery pacing: a nudge fails only while another turn is live, and turns end, so a bounded retry converges.
const RETRY_MS = 5_000;
const ATTEMPTS = 12;

export interface VerifyNudgeRuntime {
    readonly logger: Logger;
    // Where each conversation's nudge guard lives.
    readonly conversations: Pick<ConversationActors, "send">;
    readonly start: (turn: AgentTurn & { conversationId: string }) => Promise<boolean>;
    readonly sessionIdOf: (conversationId: string) => string | undefined;
}

let runtime: VerifyNudgeRuntime | undefined;

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
    // The turn that just ended, which the follow-up runs as: same provider, model, reasoning, persona and job.
    readonly profile: TurnProfile;
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
    // A nudge answering a nudge is the loop this guard exists for; spent here so the next turn is free again.
    if (live.conversations.send(nudge.conversationId, { kind: "nudge-disarmed" }).reply) {
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
    live.conversations.send(nudge.conversationId, { kind: "nudge-armed" });
    for (const ask of asks) {
        nudge.onFired?.(ask.rule);
    }
    void deliver(live, nudge, message).catch((error: unknown) =>
        live.logger.error({ err: error, conversationId: nudge.conversationId }, "verify nudge: delivery crashed"),
    );
    return message;
};

const deliver = async (live: VerifyNudgeRuntime, nudge: VerifyNudge, message: string): Promise<void> => {
    const { conversationId, profile } = nudge;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const sessionId = live.sessionIdOf(conversationId);
        try {
            const started = await live.start({
                prompt: message,
                conversationId,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...profile,
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
    live.conversations.send(conversationId, { kind: "nudge-disarmed" });
    live.logger.warn({ conversationId }, "verify nudge: could not start a follow-up, the turn stands unverified");
};

// The runtime with its seams bound, exported so tests can stand fakes into every slot.
export const startVerifyNudgeRuntime = (live: VerifyNudgeRuntime): (() => void) => {
    runtime = live;
    return () => {
        runtime = undefined;
    };
};

// Boot wiring: the same detached-turn door every daemon-started turn uses, which journals the wake so a daemon death
// between start and first frame re-runs it.
export const startVerifyNudges = (services: Pick<Services, "logger" | "conversations" | "turns">): (() => void) =>
    startVerifyNudgeRuntime({
        logger: services.logger,
        conversations: services.conversations,
        start: async (turn) => (await services.turns.start(turn)) !== undefined,
        sessionIdOf: (conversationId) => services.conversations.sessionIdOf(conversationId),
    });
