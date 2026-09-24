import {
    type AgentEvent,
    capabilitiesOf,
    changedParts,
    gatingWindows,
    type KeepWarmEnd,
    keepWarmCap,
    keepWarmDueAt,
    type PromptFingerprint,
} from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import type { Holding } from "../../../agents/actor/conversation-holdings.js";
import { type IsolationAnchor, startAnchor } from "../../../agents/worktrees/isolation.js";
import { ensureFreshToken, holdAccount } from "../../../runtimes/claude/claude-credentials.js";
import { opt } from "../../../opt.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import { SteeringQueue } from "../../checkpoints/agent-steering.js";
import type { AgentRequest, HarnessCredential } from "../../providers/agent-request.js";
import type { HarnessRequest } from "../agent.js";
import { recordFrame } from "../frames/frame-effects.js";
import { KEYED_PARTS, nextPromptDayAt } from "../prompt-fingerprint.js";
import { costOf } from "../settle/turn-settlement.js";
import { withCacheTtl } from "./prompt-cache.js";
import { sumUsage, type UsageFrame } from "./turn-usage.js";

// A refresh replays the last turn's own request through the same builder, so the prefix it reads is the one that turn wrote.

type OauthCredential = Extract<HarnessCredential, { readonly kind: "claude-oauth" }>;

export interface WarmRecipe {
    readonly request: AgentRequest<OauthCredential>;
    readonly account: string;
    // The session the turn ended on; a refresh forks it, and a conversation that moved on has nothing here to keep.
    readonly sessionId: string;
    readonly fingerprint: PromptFingerprint | undefined;
}

export type KeepWarmDeps = Pick<Services, "agent" | "agents" | "claudeStore" | "cliProxy" | "conversations" | "headroom" | "logger" | "sandboxSettings" | "usage">;

const RECIPES: Holding<WarmRecipe> = { name: "keep-warm recipes" };
// Conversations with a live hold, so a pass walks those alone.
const ARMED: Holding<true> = { name: "keep-warm holds" };
const REFRESHING: Holding<AbortController> = { name: "keep-warm refreshes", dropped: (controller) => controller.abort() };

// Holds per account at once: every one re-reads its whole context on the same allowance.
export const MAX_WARM_PER_ACCOUNT = 3;

// What a refresh says; the model reads it, answers in a word, and nothing of it is saved.
export const KEEP_WARM_PROMPT = "Automated prompt-cache refresh, not a message from the user. Reply with only: ok";

const HOUR_MS = 3_600_000;

/** The recipe a settled turn leaves, or undefined when it cannot be replayed: another runtime or credential, or a spawned child. */
export const replayOf = (turn: {
    readonly input: TurnInput;
    readonly request: AgentRequest;
    readonly account: string | undefined;
    readonly sessionId: string | undefined;
    readonly fingerprint: PromptFingerprint | undefined;
    readonly spawned: boolean;
}): WarmRecipe | undefined => {
    const { input, request, account, sessionId } = turn;
    const provider = input.agent ?? "claude";
    const runtime = capabilitiesOf(provider, input.harness ?? "native").runtime;
    if (provider !== "claude" || runtime !== "claude-code" || turn.spawned || account === undefined || sessionId === undefined) {
        return undefined;
    }
    const { credential } = request;
    if (credential.kind !== "claude-oauth") {
        return undefined;
    }
    return { request: { ...request, credential }, account, sessionId, fingerprint: turn.fingerprint };
};

/** Files the settled turn's recipe, or forgets the last one when this turn left nothing to replay. */
export const noteReplay = (conversations: KeepWarmDeps["conversations"], conversationId: string, recipe: WarmRecipe | undefined): void => {
    const recipes = conversations.holdings(RECIPES);
    if (recipe === undefined) {
        recipes.drop(conversationId);
    } else {
        recipes.hold(conversationId, conversationId, recipe);
    }
    conversations.send(conversationId, { kind: "replay-noted", replayable: recipe !== undefined });
};

export type KeepWarmAnswer = { readonly ok: true } | { readonly refused: string };

const liveHoldOn = (conversations: KeepWarmDeps["conversations"], conversationId: string): boolean => {
    const kept = conversations.state(conversationId)?.keepWarm;
    return kept !== undefined && kept.ended === undefined;
};

/** Starts or moves a hold; `until` is shortened to what can honestly be kept, and refused when nothing can. */
export const armKeepWarm = (deps: Pick<KeepWarmDeps, "conversations">, conversationId: string, until: number, auto: boolean, now: number = Date.now()): KeepWarmAnswer => {
    const { conversations } = deps;
    const recipe = conversations.holdings(RECIPES).get(conversationId);
    if (recipe === undefined) {
        return { refused: "Nothing to keep warm: the last turn here was not a Claude subscription turn this sandbox can replay, or the sandbox restarted since." };
    }
    const state = conversations.state(conversationId);
    if (state?.phase.kind === "running") {
        return { refused: "A turn is running, and its own requests keep the cache warm." };
    }
    const cache = state?.turn.promptCache;
    if (cache === undefined || cache.at + cache.ttlMs <= now) {
        return { refused: "The cache is already cold: keeping it warm now would pay the whole re-read up front." };
    }
    // A live hold's refreshes count against the same budget, so re-arming cannot outrun what one cold resume is worth.
    const spent = state?.keepWarm?.ended === undefined ? (state?.keepWarm?.refreshes ?? 0) : 0;
    const capped = Math.min(until, keepWarmCap(cache, nextPromptDayAt(cache.at), spent));
    if (capped <= now) {
        return { refused: "The date in the prompt has changed since the last turn, so the next one starts a new cache anyway." };
    }
    const sharing = conversations
        .holdings(ARMED)
        .entries()
        .filter(([id]) => id !== conversationId && liveHoldOn(conversations, id) && conversations.holdings(RECIPES).get(id)?.account === recipe.account);
    if (sharing.length >= MAX_WARM_PER_ACCOUNT) {
        return { refused: `Already keeping ${MAX_WARM_PER_ACCOUNT} conversations warm on this account.` };
    }
    conversations.holdings(ARMED).hold(conversationId, conversationId, true);
    conversations.send(conversationId, { kind: "keep-warm-armed", until: capped, auto }, now);
    return { ok: true };
};

/** Stops a hold at once, and any refresh of it still in flight. */
export const dropKeepWarm = (deps: Pick<KeepWarmDeps, "conversations">, conversationId: string): void => {
    const { conversations } = deps;
    conversations.holdings(REFRESHING).get(conversationId)?.abort();
    conversations.holdings(ARMED).drop(conversationId);
    conversations.send(conversationId, { kind: "keep-warm-dropped" });
};

/** After a turn a person asked for: arms the sandbox-wide hold where the setting and the conversation allow it. */
export const autoKeepWarm = async (
    deps: KeepWarmDeps,
    settled: { readonly conversationId: string; readonly actor: string | undefined; readonly failure: string | undefined },
    now: number = Date.now(),
): Promise<void> => {
    if (settled.actor === undefined || settled.failure !== undefined) {
        return;
    }
    const settings = await deps.sandboxSettings.get();
    const tokens = deps.conversations.state(settled.conversationId)?.turn.contextTokens ?? 0;
    if (!settings.keepWarm || tokens < settings.keepWarmMinTokens) {
        return;
    }
    const answer = armKeepWarm(deps, settled.conversationId, now + settings.keepWarmHours * HOUR_MS, true, now);
    if ("refused" in answer) {
        deps.logger.debug({ conversationId: settled.conversationId, reason: answer.refused }, "keep-warm: not armed after the turn");
    }
};

// A refresh that wrote more than this found the cache gone; the tail it adds (last answer, the refresh's own words) stays under it.
const rewriteCeiling = (contextTokens: number | undefined): number => Math.max(30_000, (contextTokens ?? 0) / 5);

type Refresh =
    | { readonly kind: "refreshed"; readonly at: number; readonly ttlMs: number; readonly readTokens: number }
    | { readonly kind: "ended"; readonly reason: KeepWarmEnd; readonly detail?: string }
    | { readonly kind: "stood-down" };

interface Heard {
    drift: string[] | undefined;
    opening: { readonly read: number; readonly written: number } | undefined;
    usage: UsageFrame | undefined;
    clock: { readonly at: number; readonly ttlMs: number } | undefined;
    failure: Extract<AgentEvent, { kind: "error" }> | undefined;
}

// What one frame of a refresh adds to what the refresh has heard; a keyed part that moved stops it before its request lands.
const hear = (deps: KeepWarmDeps, recipe: WarmRecipe, heard: Heard, event: AgentEvent, stop: () => void): void => {
    switch (event.kind) {
        case "init": {
            const moved = event.prompt === undefined || recipe.fingerprint === undefined ? [] : changedParts(recipe.fingerprint, event.prompt).filter((part) => KEYED_PARTS.includes(part));
            if (moved.length > 0) {
                heard.drift = moved;
                stop();
            }
            return;
        }
        case "prompt_cache":
            heard.opening = { read: event.readTokens, written: event.writtenTokens };
            return;
        case "usage":
            heard.usage = sumUsage(heard.usage, event);
            return;
        case "context_usage": {
            const done = withCacheTtl(event, "claude", true);
            if (done.cachedAt !== undefined && done.cacheTtlMs !== undefined) {
                heard.clock = { at: done.cachedAt, ttlMs: done.cacheTtlMs };
            }
            return;
        }
        case "account_usage":
            recordFrame(deps, event, { provider: "claude", account: recipe.account, record: () => undefined });
            return;
        case "error":
            // A tool call the model tried anyway ends the single allowed round; the refresh itself already landed.
            if (event.code !== "turn-cap") {
                heard.failure ??= event;
            }
            return;
        default:
            return;
    }
};

const verdictOf = (heard: Heard, aborted: boolean, contextTokens: number | undefined, fallback: { readonly at: number; readonly ttlMs: number }): Refresh => {
    if (heard.drift !== undefined) {
        return { kind: "ended", reason: "changed", detail: heard.drift.join(", ") };
    }
    if (aborted) {
        return { kind: "stood-down" };
    }
    if (heard.failure !== undefined) {
        return { kind: "ended", reason: heard.failure.code === "rate_limit" ? "limited" : "failed", detail: heard.failure.message };
    }
    if (heard.opening === undefined) {
        return { kind: "ended", reason: "failed", detail: "No request reached the provider." };
    }
    if (heard.opening.read === 0 || heard.opening.written > rewriteCeiling(contextTokens)) {
        return { kind: "ended", reason: "rewrote", detail: `${heard.opening.written} tokens written` };
    }
    // A read restarts the entry under the lifetime it was written with; the refresh's own tail may go in under another.
    return { kind: "refreshed", at: heard.clock?.at ?? fallback.at, ttlMs: fallback.ttlMs, readTokens: heard.opening.read };
};

// The ledger row a refresh leaves: billed like a turn, marked as not being one.
const recordRefresh = (deps: KeepWarmDeps, conversationId: string, recipe: WarmRecipe, heard: Heard, verdict: Refresh): void => {
    if (heard.usage === undefined) {
        return;
    }
    void deps.usage
        .record({
            provider: "claude",
            account: recipe.account,
            ...opt("model", recipe.request.spec.model),
            harness: "native",
            outcome: verdict.kind === "ended" && verdict.reason !== "rewrote" ? "error" : "ok",
            conversationId,
            purpose: "keep-warm",
            ...costOf(heard.usage),
        })
        .catch((error: unknown) => deps.logger.warn({ err: error }, "keep-warm: ledger append failed"));
};

// The request a refresh sends: the recipe's own, forked from its session under a fresh token, attached to no conversation.
const refreshRequest = (recipe: WarmRecipe, token: string, anchor: IsolationAnchor | undefined, signal: AbortSignal): HarnessRequest => {
    const { conversationId: _conversationId, notes: _notes, steering: _steering, isolation, ...spec } = recipe.request.spec;
    return {
        ...recipe.request,
        spec: {
            ...spec,
            prompt: KEEP_WARM_PROMPT,
            sessionId: recipe.sessionId,
            steering: new SteeringQueue(),
            ...(isolation === undefined ? {} : { isolation: { plan: isolation.plan, ...opt("anchor", anchor) } }),
        },
        policy: { ...recipe.request.policy, keepWarm: true },
        credential: { ...recipe.request.credential, token },
        signal,
    };
};

/** One refresh of one conversation's cache: sent, heard out, recorded, and judged. */
export const refreshCache = async (deps: KeepWarmDeps, conversationId: string, recipe: WarmRecipe, now: number = Date.now()): Promise<Refresh> => {
    const { conversations } = deps;
    const state = conversations.state(conversationId);
    const fallback = { at: now, ttlMs: state?.turn.promptCache?.ttlMs ?? HOUR_MS };
    const token = await ensureFreshToken(deps.claudeStore, recipe.account);
    if (token === undefined) {
        return { kind: "ended", reason: "failed", detail: "The account is signed out." };
    }
    const controller = new AbortController();
    conversations.holdings(REFRESHING).hold(conversationId, conversationId, controller);
    const release = holdAccount(recipe.account);
    const heard: Heard = { drift: undefined, opening: undefined, usage: undefined, clock: undefined, failure: undefined };
    let anchor: IsolationAnchor | undefined;
    try {
        const placement = recipe.request.spec.isolation;
        anchor = placement?.anchor === undefined ? undefined : await startAnchor(placement.plan);
        for await (const event of deps.agent(refreshRequest(recipe, token, anchor, controller.signal))) {
            // A turn that began meanwhile refreshes the cache itself.
            if (conversations.state(conversationId)?.phase.kind !== "idle") {
                controller.abort();
            }
            hear(deps, recipe, heard, event, () => controller.abort());
        }
    } catch (error) {
        heard.failure ??= { kind: "error", message: error instanceof Error ? error.message : String(error) };
    } finally {
        anchor?.dispose();
        release();
        conversations.holdings(REFRESHING).drop(conversationId);
    }
    const verdict = verdictOf(heard, controller.signal.aborted, state?.turn.contextTokens, fallback);
    recordRefresh(deps, conversationId, recipe, heard, verdict);
    return verdict;
};

// The fullest limit the account's model spends, in percent; undefined when nothing was measured.
const spentOf = async (deps: KeepWarmDeps, recipe: WarmRecipe): Promise<number | undefined> => {
    const usage = (await deps.headroom.read())[recipe.account];
    const model = recipe.request.spec.model;
    const windows = gatingWindows(usage, model === undefined ? undefined : { id: model });
    return windows.length === 0 ? undefined : Math.max(...windows.map((window) => window.utilization));
};

/** One conversation's hold, looked at once: ended, waited on, or refreshed. */
export const tendKeepWarm = async (deps: KeepWarmDeps, conversationId: string, now: number = Date.now()): Promise<void> => {
    const { conversations } = deps;
    const state = conversations.state(conversationId);
    const kept = state?.keepWarm;
    if (state === undefined || kept === undefined || kept.ended !== undefined) {
        conversations.holdings(ARMED).drop(conversationId);
        return;
    }
    const end = (reason: KeepWarmEnd, detail?: string): void => {
        conversations.holdings(ARMED).drop(conversationId);
        conversations.send(conversationId, { kind: "keep-warm-ended", reason, ...opt("detail", detail) }, now);
    };
    const entry = deps.agents.entry(conversationId);
    if (entry === undefined || entry.archivedAt !== undefined) {
        dropKeepWarm(deps, conversationId);
        return;
    }
    // Something is about to run on it, whose own requests keep the cache; a paused queue runs nothing until a press.
    if (state.phase.kind !== "idle" || (state.queue.items.length > 0 && state.queue.paused === undefined)) {
        return;
    }
    const recipe = conversations.holdings(RECIPES).get(conversationId);
    if (recipe === undefined || entry.sessionId !== recipe.sessionId || (entry.profile.account !== undefined && entry.profile.account !== recipe.account)) {
        end("moved");
        return;
    }
    const cache = state.turn.promptCache;
    if (cache === undefined || cache.at + cache.ttlMs <= now) {
        end("cold");
        return;
    }
    if (now >= nextPromptDayAt(cache.at)) {
        end("midnight");
        return;
    }
    if (now >= kept.until) {
        end("elapsed");
        return;
    }
    if (cache.at + cache.ttlMs >= kept.until || now < keepWarmDueAt(cache)) {
        return;
    }
    const spent = await spentOf(deps, recipe);
    const { keepWarmReserve } = await deps.sandboxSettings.get();
    if (spent !== undefined && spent >= 100 - keepWarmReserve) {
        end("allowance", `${Math.round(spent)}%`);
        return;
    }
    const verdict = await refreshCache(deps, conversationId, recipe, now);
    if (verdict.kind === "refreshed") {
        conversations.send(conversationId, { kind: "keep-warm-refreshed", at: verdict.at, ttlMs: verdict.ttlMs, readTokens: verdict.readTokens });
    } else if (verdict.kind === "ended") {
        end(verdict.reason, verdict.detail);
    }
};

export interface KeepWarmScheduler {
    readonly tick: () => Promise<void>;
    readonly start: () => void;
    readonly stop: () => void;
}

// One hold at a time, so two refreshes never race on one account's allowance or on the CLI's spawn.
export const createKeepWarmScheduler = (deps: KeepWarmDeps, intervalMs = 15_000): KeepWarmScheduler => {
    let timer: NodeJS.Timeout | undefined;
    let busy = false;
    const tick = async (): Promise<void> => {
        if (busy) {
            return;
        }
        busy = true;
        try {
            for (const [conversationId] of deps.conversations.holdings(ARMED).entries()) {
                await tendKeepWarm(deps, conversationId).catch((error: unknown) => deps.logger.warn({ err: error, conversationId }, "keep-warm: tending a hold failed"));
            }
        } finally {
            busy = false;
        }
    };
    return {
        tick,
        start: () => {
            timer = setInterval(() => void tick(), intervalMs);
            timer.unref();
        },
        stop: () => clearInterval(timer),
    };
};
