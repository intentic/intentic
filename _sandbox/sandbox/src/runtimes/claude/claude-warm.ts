import type { AgentEvent } from "@intentic/sandbox-contract";
import type { ProviderWarm, WarmReplay, WarmTurn } from "../../agent/providers/provider-module.js";
import type { TurnHooks, TurnSpec } from "../../agent/providers/agent-request.js";
import { SteeringQueue } from "../../agent/checkpoints/agent-steering.js";
import type { HarnessRequest } from "../../agent/run/agent.js";
import type { Services } from "../../composition.js";
import type { IsolationAnchor } from "../../conversations/worktrees/isolation.js";
import { opt } from "../../opt.js";
import { ensureFreshToken, holdAccount } from "./claude-credentials.js";
import { agentExecutionScope, assertAgentExecution, requireRootAgentExecution, type AgentExecutionContext } from "../../workload/agent-execution.js";

// Keeping a Claude conversation's prompt cache warm: one forked, unsaved request on the subscription account that served
// the last turn, carrying that turn's prefix (system prompt, tools, model, reasoning) and a one-word prompt. The Claude
// Code loop turns `policy.keepWarm` into the refresh's own options (agent/run/agent.ts keepWarmOptions).

export type ClaudeWarmDeps = Pick<Services, "agent" | "claudeStore" | "agentExecution">;

// What a refresh says; the model reads it, answers in a word, and nothing of it is saved.
export const KEEP_WARM_PROMPT = "Automated prompt-cache refresh, not a message from the user. Reply with only: ok";

const HOUR_MS = 3_600_000;

// Anthropic's price multipliers on base input: a read costs 0.1x, a write 2x under the 1h TTL and 1.25x under 5m.
const READ_COST = 0.1;
const writeCost = (ttlMs: number): number => (ttlMs >= HOUR_MS ? 2 : 1.25);

/** Refreshes one hold may spend: half of what a cold resume rewrites, the other half left for each refresh's own tail. */
export const claudeWarmBudget = (ttlMs: number): number => Math.floor((writeCost(ttlMs) - READ_COST) / READ_COST / 2);

// The parts of the turn's words-and-place that shape the cached prefix, named one by one: a field added to TurnSpec
// later reaches no refresh until it is listed here, so nothing the turn did (its notes, its conversation, its steering)
// is sent again by default.
type WarmSpec = Pick<
    TurnSpec,
    "cwd" | "ownCheckout" | "model" | "effort" | "thinking" | "fast" | "systemPromptMode" | "systemPrompt" | "systemAppend" | "contextTrim" | "search"
>;

const warmSpec = (spec: TurnSpec): WarmSpec => ({
    cwd: spec.cwd,
    ...opt("ownCheckout", spec.ownCheckout),
    ...opt("model", spec.model),
    ...opt("effort", spec.effort),
    ...opt("thinking", spec.thinking),
    ...opt("fast", spec.fast),
    ...opt("systemPromptMode", spec.systemPromptMode),
    ...opt("systemPrompt", spec.systemPrompt),
    ...opt("systemAppend", spec.systemAppend),
    ...opt("contextTrim", spec.contextTrim),
    // Which search tool the guidance names, iq or rg: a line of the system prompt, so of the prefix.
    ...opt("search", spec.search),
});

// Everything one refresh is built from. The policy and tools travel whole since they are the prefix's tool list and the
// system prompt's facts, and every tool call is refused; of the hooks only the card seam the permission gate needs.
interface ClaudeWarmRecipe {
    readonly spec: WarmSpec;
    readonly placement: HarnessRequest["spec"]["isolation"];
    readonly policy: HarnessRequest["policy"];
    readonly tools: HarnessRequest["tools"];
    readonly cards: TurnHooks["cards"];
    readonly account: string;
    readonly sessionId: string;
    readonly anchor: WarmTurn["anchor"];
}

// The refresh request: the recipe forked from its session under a fresh token, in a namespace of its own when the turn
// had one, attached to no conversation.
const refreshRequest = (recipe: ClaudeWarmRecipe, execution: AgentExecutionContext, token: string, anchor: IsolationAnchor | undefined, signal: AbortSignal): HarnessRequest => ({
    execution,
    spec: {
        ...recipe.spec,
        prompt: KEEP_WARM_PROMPT,
        sessionId: recipe.sessionId,
        steering: new SteeringQueue(),
        ...opt("isolation", recipe.placement === undefined ? undefined : { plan: recipe.placement.plan, ...opt("anchor", anchor) }),
    },
    policy: { ...recipe.policy, keepWarm: true },
    tools: recipe.tools,
    hooks: { cards: recipe.cards },
    credential: { kind: "claude-oauth", token },
    signal,
});

async function* sendRefresh(deps: ClaudeWarmDeps, recipe: ClaudeWarmRecipe, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    // The recorded turn context has already been released. Every refresh independently reads protected policy; the
    // existing root anchor factory is guarded before it runs, never used to build an unprivileged replacement.
    const admission = await deps.agentExecution.admit();
    const gate = agentExecutionScope(deps.agentExecution, admission);
    const scope = agentExecutionScope(deps.agentExecution, admission);
    try {
        const gateContext = gate.acquire({ localCwd: recipe.spec.cwd });
        requireRootAgentExecution(gateContext, "Claude cache refresh");
        const token = await ensureFreshToken(deps.claudeStore, recipe.account);
        if (token === undefined) {
            yield { kind: "error", message: "The account is signed out." };
            return;
        }
        requireRootAgentExecution(gateContext, "Claude cache refresh");
        const release = holdAccount(recipe.account);
        try {
            const anchor = recipe.placement?.anchor === undefined ? undefined : await recipe.anchor(recipe.placement.plan);
            const isolation = recipe.placement === undefined ? undefined : { plan: recipe.placement.plan, ...opt("anchor", anchor) };
            const execution = scope.acquire({ localCwd: recipe.spec.cwd, ...opt("isolation", isolation) });
            yield* deps.agent(refreshRequest(recipe, execution, token, anchor, signal));
        } finally {
            release();
        }
    } finally {
        try { scope.dispose(); }
        finally {
            try { gate.dispose(); }
            finally { deps.agentExecution.close(admission); }
        }
    }
}

/** A settled turn's refresh, or undefined for one no refresh can spend: only a stored subscription account's token can. */
export const claudeKeepable = (deps: ClaudeWarmDeps, turn: WarmTurn): WarmReplay | undefined => {
    const { request, account, sessionId, anchor } = turn;
    if (request.credential.kind !== "claude-oauth") {
        return undefined;
    }
    assertAgentExecution(request.execution, request.spec);
    requireRootAgentExecution(request.execution, "Claude cache refresh", request.spec.cwd);
    const recipe: ClaudeWarmRecipe = {
        spec: warmSpec(request.spec),
        placement: request.spec.isolation,
        policy: request.policy,
        tools: request.tools,
        cards: request.hooks.cards,
        account,
        sessionId,
        anchor,
    };
    return { model: request.spec.model, send: (signal) => sendRefresh(deps, recipe, signal) };
};

export const claudeWarm: ProviderWarm<ClaudeWarmDeps> = { keepable: claudeKeepable, budget: claudeWarmBudget };
