import {
    type AgentEvent,
    type AgentProvider,
    capabilitiesOf,
    changedParts,
    type KeepWarm,
    type KeepWarmEnd,
    keepWarmCap,
    keepWarmDueAt,
    type PromptFingerprint,
    SPENT_UTILIZATION,
    spokenByPerson,
    type TurnSpeaker,
} from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import { deadlineKind, deadlines, type Deadlines } from "../../../conversations/actor/conversation-deadline.js";
import { startAnchor } from "../../../conversations/worktrees/isolation.js";
import type { Holding } from "../../../conversations/actor/conversation-holdings.js";
import { opt } from "../../../opt.js";
import type { ProviderDeps } from "../../../runtimes/runtime-table.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import { serviceability, type ServiceabilityDeps } from "../../../usage/serviceability/serviceability.js";
import type { AgentRequest } from "../../providers/agent-request.js";
import type { WarmReplay } from "../../providers/provider-module.js";
import { recordFrame } from "../frames/frame-effects.js";
import { KEYED_PARTS, nextPromptDayAt } from "../prompt-fingerprint.js";
import { costOf } from "../settle/turn-settlement.js";
import { withCacheTtl } from "./prompt-cache.js";
import { sumUsage, type UsageFrame } from "./turn-usage.js";

// Keep-warm: holding an idle conversation's prompt cache open by re-reading it shortly before it expires. This module
// owns the hold (when it is due, how far it may reach, why it ends); the provider that served the last turn owns the
// refresh itself and its prices (ProviderModule.warm, runtimes/claude/claude-warm.ts). One name for the fact that a
// conversation can be kept: `keepable`, in the holding below, in its state (turn.keepable) and on its card
// (promptCache.keepableUntil).

// What a settled turn leaves to refresh its cache by: its provider's replay, and what the hold checks it against.
export interface Keepable extends WarmReplay {
    readonly provider: AgentProvider;
    readonly harness: RoutedTurn["harness"];
    readonly account: string;
    // The session the turn ended on; a refresh forks it, and a conversation that moved on has nothing here to keep.
    readonly sessionId: string;
    readonly fingerprint: PromptFingerprint | undefined;
}

export type KeepWarmDeps = ServiceabilityDeps & Pick<Services, "agents" | "conversations" | "headroom" | "logger" | "sandboxSettings" | "usage">;

const KEEPABLE: Holding<Keepable> = { name: "keepable" };
const REFRESHING: Holding<AbortController> = { name: "keep-warm refreshes", dropped: (controller) => controller.abort() };
// Each live hold's next look, at the exact instant something about it is due.
const DUE = deadlineKind("keep-warm");

// Holds per account at once: every one re-reads its whole context on the same allowance.
export const MAX_WARM_PER_ACCOUNT = 3;

const HOUR_MS = 3_600_000;
// A look that found a turn about to start, whose own requests keep the cache, looks again this much later.
const BUSY_RETRY_MS = 15_000;

const dueOf = (deps: Pick<KeepWarmDeps, "conversations" | "logger">): Deadlines =>
    deadlines(deps.conversations, DUE, (conversationId, error) => deps.logger.warn({ err: error, conversationId }, "keep-warm: tending a hold failed"));

/** What a settled turn leaves to keep its cache by, or undefined: a spawned child, a runtime or provider that cannot, a credential it cannot spend. */
export const keepableOf = (
    deps: ProviderDeps & Pick<Services, "providerModules">,
    turn: {
        readonly input: RoutedTurn;
        readonly request: AgentRequest;
        readonly account: string | undefined;
        readonly sessionId: string | undefined;
        readonly fingerprint: PromptFingerprint | undefined;
        readonly spawned: boolean;
    },
): Keepable | undefined => {
    const { input, request, account, sessionId } = turn;
    if (turn.spawned || account === undefined || sessionId === undefined || !capabilitiesOf(input.agent, input.harness).warm) {
        return undefined;
    }
    const replay = deps.providerModules.find((module) => module.id === input.agent)?.warm?.keepable(deps, { request, account, sessionId, anchor: startAnchor });
    return replay === undefined ? undefined : { ...replay, provider: input.agent, harness: input.harness, account, sessionId, fingerprint: turn.fingerprint };
};

/** Files a settled turn's keepable, or forgets the last one when this turn left nothing to keep; the conversation's state says which, with the refreshes its provider's prices allow. */
export const noteKeepable = (deps: Pick<Services, "conversations" | "providerModules">, conversationId: string, keepable: Keepable | undefined): void => {
    const { conversations } = deps;
    const ttlMs = conversations.state(conversationId)?.turn.promptCache?.ttlMs;
    const warm = keepable === undefined ? undefined : deps.providerModules.find((module) => module.id === keepable.provider)?.warm;
    if (keepable === undefined || warm === undefined || ttlMs === undefined) {
        conversations.holdings(KEEPABLE).drop(conversationId);
        conversations.send(conversationId, { kind: "keepable-noted", keepable: undefined });
        return;
    }
    conversations.holdings(KEEPABLE).hold(conversationId, conversationId, keepable);
    conversations.send(conversationId, { kind: "keepable-noted", keepable: { budget: warm.budget(ttlMs) } });
};

export type KeepWarmAnswer = { readonly ok: true } | { readonly refused: string };

const liveHold = (deps: Pick<KeepWarmDeps, "conversations">, conversationId: string): KeepWarm | undefined => {
    const kept = deps.conversations.state(conversationId)?.keepWarm;
    return kept?.ended === undefined ? kept : undefined;
};

// The next instant this hold needs looking at: its refresh, or the moment it ends by itself, whichever comes first.
const nextLookAt = (cache: { readonly at: number; readonly ttlMs: number }, kept: KeepWarm): number =>
    Math.min(kept.until, nextPromptDayAt(cache.at), cache.at + cache.ttlMs >= kept.until ? Number.POSITIVE_INFINITY : keepWarmDueAt(cache));

// Sets the hold's one deadline, or clears it for a conversation with no live hold.
const schedule = (deps: KeepWarmDeps, conversationId: string, at: number | undefined, now: number): void => {
    const due = dueOf(deps);
    if (at === undefined) {
        due.clear(conversationId);
        return;
    }
    due.set(conversationId, at, () => tendKeepWarm(deps, conversationId), now);
};

const scheduleNext = (deps: KeepWarmDeps, conversationId: string, now: number): void => {
    const state = deps.conversations.state(conversationId);
    const kept = liveHold(deps, conversationId);
    const cache = state?.turn.promptCache;
    schedule(deps, conversationId, kept === undefined || cache === undefined ? undefined : nextLookAt(cache, kept), now);
};

/** Starts or moves a hold; `until` is shortened to what can honestly be kept, and refused when nothing can. */
export const armKeepWarm = (deps: KeepWarmDeps, conversationId: string, until: number, now: number = Date.now()): KeepWarmAnswer => {
    const { conversations } = deps;
    const keepable = conversations.holdings(KEEPABLE).get(conversationId);
    const state = conversations.state(conversationId);
    const budget = state?.turn.keepable?.budget;
    if (keepable === undefined || budget === undefined) {
        return { refused: "Nothing to keep warm: the last turn here was not one this sandbox can replay (a Claude subscription turn), or the sandbox restarted since." };
    }
    if (state?.phase.kind === "running") {
        return { refused: "A turn is running, and its own requests keep the cache warm." };
    }
    const cache = state?.turn.promptCache;
    if (cache === undefined || cache.at + cache.ttlMs <= now) {
        return { refused: "The cache is already cold: keeping it warm now would pay the whole re-read up front." };
    }
    // A live hold's refreshes count against the same budget, so re-arming cannot outrun what one cold resume is worth.
    const capped = Math.min(until, keepWarmCap(cache, nextPromptDayAt(cache.at), budget - (liveHold(deps, conversationId)?.refreshes ?? 0)));
    if (capped <= now) {
        return { refused: "The date in the prompt has changed since the last turn, so the next one starts a new cache anyway." };
    }
    const sharing = conversations
        .holdings(KEEPABLE)
        .entries()
        .filter(([id, other]) => id !== conversationId && other.account === keepable.account && liveHold(deps, id) !== undefined);
    if (sharing.length >= MAX_WARM_PER_ACCOUNT) {
        return { refused: `Already keeping ${MAX_WARM_PER_ACCOUNT} conversations warm on this account.` };
    }
    conversations.send(conversationId, { kind: "keep-warm-armed", until: capped }, now);
    scheduleNext(deps, conversationId, now);
    return { ok: true };
};

/** Stops a hold at once, and any refresh of it still in flight; a stop press leaves no ending on the card. */
export const dropKeepWarm = (deps: KeepWarmDeps, conversationId: string): void => {
    const { conversations } = deps;
    conversations.holdings(REFRESHING).get(conversationId)?.abort();
    dueOf(deps).clear(conversationId);
    conversations.send(conversationId, { kind: "keep-warm-ended" });
};

/** After a turn a person asked for: arms a hold where the sandbox-wide setting and the conversation allow it. */
export const autoKeepWarm = async (
    deps: KeepWarmDeps,
    settled: { readonly conversationId: string; readonly speaker: TurnSpeaker | undefined; readonly failure: string | undefined },
    now: number = Date.now(),
): Promise<void> => {
    // A person at the keyboard, not a program holding a token a person minted: only they come back to a warm cache.
    if (!spokenByPerson(settled.speaker) || settled.failure !== undefined) {
        return;
    }
    const { keepWarm } = await deps.sandboxSettings.get();
    const tokens = deps.conversations.state(settled.conversationId)?.turn.contextTokens ?? 0;
    if (!keepWarm.auto || tokens < keepWarm.minTokens) {
        return;
    }
    const answer = armKeepWarm(deps, settled.conversationId, now + keepWarm.hours * HOUR_MS, now);
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
const hear = (deps: KeepWarmDeps, keepable: Keepable, heard: Heard, event: AgentEvent, stop: () => void): void => {
    switch (event.kind) {
        case "init": {
            const moved = event.prompt === undefined || keepable.fingerprint === undefined ? [] : changedParts(keepable.fingerprint, event.prompt).filter((part) => KEYED_PARTS.includes(part));
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
            const done = withCacheTtl(event, keepable.provider, true);
            if (done.cachedAt !== undefined && done.cacheTtlMs !== undefined) {
                heard.clock = { at: done.cachedAt, ttlMs: done.cacheTtlMs };
            }
            return;
        }
        case "account_usage":
            recordFrame(deps, event, { provider: keepable.provider, account: keepable.account, record: () => undefined });
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
        return { kind: "ended", reason: heard.failure.code === "rate_limit" ? "allowance" : "failed", detail: heard.failure.message };
    }
    if (heard.opening === undefined) {
        return { kind: "ended", reason: "failed", detail: "No request reached the provider." };
    }
    if (heard.opening.read === 0 || heard.opening.written > rewriteCeiling(contextTokens)) {
        return { kind: "ended", reason: "cold", detail: `a refresh wrote ${heard.opening.written} tokens again` };
    }
    // A read restarts the entry under the lifetime it was written with; the refresh's own tail may go in under another.
    return { kind: "refreshed", at: heard.clock?.at ?? fallback.at, ttlMs: fallback.ttlMs, readTokens: heard.opening.read };
};

// The ledger row a refresh leaves: billed like a turn, marked as not being one.
const recordRefresh = (deps: KeepWarmDeps, conversationId: string, keepable: Keepable, heard: Heard, verdict: Refresh): void => {
    if (heard.usage === undefined) {
        return;
    }
    void deps.usage
        .record({
            provider: keepable.provider,
            account: keepable.account,
            ...opt("model", keepable.model),
            harness: keepable.harness,
            outcome: verdict.kind === "ended" && verdict.reason !== "cold" ? "error" : "ok",
            conversationId,
            purpose: "keep-warm",
            ...costOf(heard.usage),
        })
        .catch((error: unknown) => deps.logger.warn({ err: error }, "keep-warm: ledger append failed"));
};

/** One refresh of one conversation's cache: sent by its provider, heard out, recorded, and judged. */
export const refreshCache = async (deps: KeepWarmDeps, conversationId: string, keepable: Keepable, now: number = Date.now()): Promise<Refresh> => {
    const { conversations } = deps;
    const state = conversations.state(conversationId);
    const fallback = { at: now, ttlMs: state?.turn.promptCache?.ttlMs ?? HOUR_MS };
    const controller = new AbortController();
    conversations.holdings(REFRESHING).hold(conversationId, conversationId, controller);
    const heard: Heard = { drift: undefined, opening: undefined, usage: undefined, clock: undefined, failure: undefined };
    try {
        for await (const event of keepable.send(controller.signal)) {
            // A turn that began meanwhile refreshes the cache itself.
            if (conversations.state(conversationId)?.phase.kind !== "idle") {
                controller.abort();
            }
            hear(deps, keepable, heard, event, () => controller.abort());
        }
    } catch (error) {
        heard.failure ??= { kind: "error", message: error instanceof Error ? error.message : String(error) };
    } finally {
        conversations.holdings(REFRESHING).drop(conversationId);
    }
    const verdict = verdictOf(heard, controller.signal.aborted, state?.turn.contextTokens, fallback);
    recordRefresh(deps, conversationId, keepable, heard, verdict);
    return verdict;
};

// Whether the account can afford another refresh, by the one serviceability rule: a refresh is itself a turn, so it
// stops where the rule says no turn runs, and short of that, once only the owner's reserve is left. Unmeasured goes on.
const allowanceStop = async (deps: KeepWarmDeps, keepable: Keepable): Promise<{ readonly reason: KeepWarmEnd; readonly detail: string } | undefined> => {
    const state = await serviceability(deps, keepable.provider, keepable.account, keepable.model === undefined ? undefined : { id: keepable.model });
    if (state.kind === "blocked") {
        return { reason: "failed", detail: state.reason };
    }
    if (state.kind === "spent") {
        return { reason: "allowance", detail: `${SPENT_UTILIZATION}%` };
    }
    const { reserve } = (await deps.sandboxSettings.get()).keepWarm;
    return state.kind === "ready" && state.room <= reserve ? { reason: "allowance", detail: `${Math.round(SPENT_UTILIZATION - state.room)}%` } : undefined;
};

// Why the cache this hold keeps is no longer the one the next turn reads; undefined while it still is.
const movedOn = (deps: KeepWarmDeps, conversationId: string, keepable: Keepable | undefined): string | undefined => {
    const entry = deps.agents.entry(conversationId);
    if (keepable === undefined || entry?.sessionId !== keepable.sessionId) {
        return "the conversation moved to another session";
    }
    return entry.profile.account !== undefined && entry.profile.account !== keepable.account ? "the conversation moved to another account" : undefined;
};

/** One conversation's hold, looked at when its deadline falls: ended, looked at again later, or refreshed. */
export const tendKeepWarm = async (deps: KeepWarmDeps, conversationId: string, now: number = Date.now()): Promise<void> => {
    const { conversations } = deps;
    const state = conversations.state(conversationId);
    const kept = liveHold(deps, conversationId);
    if (state === undefined || kept === undefined) {
        schedule(deps, conversationId, undefined, now);
        return;
    }
    const end = (reason: KeepWarmEnd, detail?: string): void => {
        schedule(deps, conversationId, undefined, now);
        conversations.send(conversationId, { kind: "keep-warm-ended", reason, ...opt("detail", detail) }, now);
    };
    const entry = deps.agents.entry(conversationId);
    if (entry === undefined || entry.archivedAt !== undefined) {
        dropKeepWarm(deps, conversationId);
        return;
    }
    // Something is about to run on it, whose own requests keep the cache; a paused queue runs nothing until a press.
    if (state.phase.kind !== "idle" || (state.queue.items.length > 0 && state.queue.paused === undefined)) {
        schedule(deps, conversationId, now + BUSY_RETRY_MS, now);
        return;
    }
    const keepable = conversations.holdings(KEEPABLE).get(conversationId);
    const moved = movedOn(deps, conversationId, keepable);
    if (moved !== undefined || keepable === undefined) {
        end("changed", moved);
        return;
    }
    const cache = state.turn.promptCache;
    if (cache === undefined || cache.at + cache.ttlMs <= now) {
        end("cold", "it expired before a refresh could run");
        return;
    }
    if (now >= nextPromptDayAt(cache.at)) {
        end("changed", "the date in the prompt");
        return;
    }
    if (now >= kept.until) {
        end("elapsed");
        return;
    }
    if (cache.at + cache.ttlMs >= kept.until || now < keepWarmDueAt(cache)) {
        scheduleNext(deps, conversationId, now);
        return;
    }
    const stop = await allowanceStop(deps, keepable);
    if (stop !== undefined) {
        end(stop.reason, stop.detail);
        return;
    }
    const verdict = await refreshCache(deps, conversationId, keepable, now);
    if (verdict.kind === "refreshed") {
        conversations.send(conversationId, { kind: "keep-warm-refreshed", at: verdict.at, ttlMs: verdict.ttlMs, readTokens: verdict.readTokens });
        scheduleNext(deps, conversationId, verdict.at);
    } else if (verdict.kind === "ended") {
        end(verdict.reason, verdict.detail);
    }
};

/** When this conversation's hold is next looked at; undefined when nothing is set. */
export const keepWarmDueOf = (deps: Pick<KeepWarmDeps, "conversations" | "logger">, conversationId: string): number | undefined => dueOf(deps).at(conversationId);

/** Clears every hold's deadline, for a daemon shutting down; the holds themselves go with the process. */
export const stopKeepWarm = (deps: Pick<KeepWarmDeps, "conversations" | "logger">): void => dueOf(deps).clearAll();
