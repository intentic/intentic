import type { AgentEvent } from "@intentic/sandbox-contract";
import type { ProviderWarm, WarmReplay, WarmTurn } from "../../agent/providers/provider-module.js";
import type { TurnHooks, TurnSpec } from "../../agent/providers/agent-request.js";
import { SteeringQueue } from "../../agent/checkpoints/agent-steering.js";
import type { HarnessRequest } from "../../agent/run/agent.js";
import type { Services } from "../../composition.js";
import type { IsolationAnchor } from "../../conversations/worktrees/isolation.js";
import { opt } from "../../opt.js";
import { ensureFreshToken, holdAccount } from "./claude-credentials.js";

// Keeping a Claude conversation's prompt cache warm: one forked, unsaved request on the subscription account that served
// the last turn, carrying that turn's prefix (system prompt, tools, model, reasoning) and a one-word prompt. The Claude
// Code loop turns `policy.keepWarm` into the refresh's own options (agent/run/agent.ts keepWarmOptions).

export type ClaudeWarmDeps = Pick<Services, "agent" | "claudeStore">;

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
    "cwd" | "ownCheckout" | "model" | "effort" | "thinking" | "fast" | "systemPromptMode" | "systemPrompt" | "systemAppend" | "contextTrim" | "guidance"
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
    ...opt("guidance", spec.guidance),
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
const refreshRequest = (recipe: ClaudeWarmRecipe, token: string, anchor: IsolationAnchor | undefined, signal: AbortSignal): HarnessRequest => ({
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
    const token = await ensureFreshToken(deps.claudeStore, recipe.account);
    if (token === undefined) {
        yield { kind: "error", message: "The account is signed out." };
        return;
    }
    const release = holdAccount(recipe.account);
    let anchor: IsolationAnchor | undefined;
    try {
        anchor = recipe.placement?.anchor === undefined ? undefined : await recipe.anchor(recipe.placement.plan);
        yield* deps.agent(refreshRequest(recipe, token, anchor, signal));
    } finally {
        anchor?.dispose();
        release();
    }
}

/** A settled turn's refresh, or undefined for one no refresh can spend: only a stored subscription account's token can. */
export const claudeKeepable = (deps: ClaudeWarmDeps, turn: WarmTurn): WarmReplay | undefined => {
    const { request, account, sessionId, anchor } = turn;
    if (request.credential.kind !== "claude-oauth") {
        return undefined;
    }
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
