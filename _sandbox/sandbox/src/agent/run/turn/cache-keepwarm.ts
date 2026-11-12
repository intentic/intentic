import { errorMessage } from "@intentic/base/errors";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import {
    changedParts,
    type KeepWarm,
    type KeepWarmEnd,
    keepWarmCap,
    keepWarmDueAt,
    type PromptFingerprint,
} from "@intentic/sandbox-contract/schemas/keep-warm";
import { SPENT_UTILIZATION } from "@intentic/sandbox-contract/models/plan-pools";
import { spokenByPerson, type TurnSpeaker } from "@intentic/sandbox-contract/schemas/speaker";
import type { Services } from "../../../composition.js";
import { deadlineKind, deadlines, type Deadlines } from "../../../conversations/actor/conversation-deadline.js";
import { startAnchor } from "../../../conversations/worktrees/isolation.js";
import type { Holding } from "../../../conversations/actor/conversation-holdings.js";
import { holdOf, waitingOf } from "../../../conversations/actor/conversation-queue.js";
import { childrenAtWorkOf } from "../../../conversations/actor/subagent-roster.js";
import { opt } from "../../../opt.js";
import type { ProviderDeps } from "../../../runtimes/runtime-table.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import { serviceability, type ServiceabilityDeps } from "../../../usage/serviceability/serviceability.js";
import type { AgentRequest } from "../../providers/agent-request.js";
import type { WarmReplay } from "../../providers/provider-module.js";
import { recordFrame } from "../frames/frame-effects.js";
import { KEYED_PARTS } from "../prompt-fingerprint.js";
import { costOf } from "../settle/turn-settlement.js";
import { withCacheTtl } from "./prompt-cache.js";
import { sumUsage, type UsageFrame } from "./turn-usage.js";
import { nextPromptDayAt } from "../../../conversations/actor/conversation-state.js";

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
// A hold armed because its conversation's subagents were at work, and the person's own hold it falls back to once none
// is (`auto` after a turn they asked for), else nothing. Any other arming or stop clears it.
const FOR_SUBAGENTS: Holding<{ readonly fallback: number | undefined }> = { name: "keep-warm for subagents" };
// Each live hold's next look, at the exact instant something about it is due.
const DUE = deadlineKind("keep-warm");

// Holds per account at once: every one re-reads its whole context on the same allowance.
export const MAX_WARM_PER_ACCOUNT = 3;

const HOUR_MS = 3_600_000;
// A look that found a turn about to start, whose own requests keep the cache, looks again this much later.
const BUSY_RETRY_MS = 15_000;
// What a hold for working subagents asks for: no end of its own, so the cap (what refreshing is worth, and midnight)
// sets it, and the subagents finishing ends it sooner.
const SUBAGENTS_REACH_MS = 24 * HOUR_MS;

const dueOf = (deps: Pick<KeepWarmDeps, "conversations" | "logger">): Deadlines =>
    deadlines(deps.conversations, DUE, (conversationId, error) => deps.logger.warn({ err: error, conversationId }, "keep-warm: tending a hold failed"));

/**
 * What a settled turn leaves to keep its cache by, or undefined: a spawned child, a runtime or provider that cannot, a
 * credential it cannot spend, or a turn whose placement ended under it (its mount anchor gone, so its execution no
 * longer stands). Asked in the turn's `finally`, before it is settled, so it never throws: keeping a cache is a nicety,
 * and a refusal here must not keep the turn from being settled, nor have it reported as that refusal.
 */
export const keepableOf = (
    deps: ProviderDeps & Pick<Services, "providerModules" | "logger">,
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
    let replay: WarmReplay | undefined;
    try {
        replay = deps.providerModules.find((module) => module.id === input.agent)?.warm?.keepable(deps, { request, account, sessionId, anchor: startAnchor });
    } catch (error) {
        deps.logger.warn({ err: error, conversationId: input.conversationId }, "keep-warm: the settled turn's cache cannot be kept");
        return undefined;
    }
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
    const answer = arm(deps, conversationId, until, now);
    // A hold a person armed or moved runs to the end they asked for, whatever the subagents do.
    if ("ok" in answer) {
        deps.conversations.holdings(FOR_SUBAGENTS).drop(conversationId);
    }
    return answer;
};

const arm = (deps: KeepWarmDeps, conversationId: string, until: number, now: number): KeepWarmAnswer => {
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
    conversations.holdings(FOR_SUBAGENTS).drop(conversationId);
    dueOf(deps).clear(conversationId);
    conversations.send(conversationId, { kind: "keep-warm-ended" });
};

/**
 * After a turn: arms a hold where the sandbox-wide settings and the conversation allow it. Two reasons can: a person
 * asked for the turn and `auto` is on, or subagents it started are still at work (`subagents`, on by default), whose
 * reports will wake it whoever asked. The second asks for no end of its own and ends once none of them is at work.
 */
export const autoKeepWarm = async (
    deps: KeepWarmDeps,
    settled: { readonly conversationId: string; readonly speaker: TurnSpeaker | undefined; readonly failure: string | undefined },
    now: number = Date.now(),
): Promise<void> => {
    const { conversationId } = settled;
    if (settled.failure !== undefined) {
        return;
    }
    const { keepWarm } = await deps.sandboxSettings.get();
    const tokens = deps.conversations.state(conversationId)?.turn.contextTokens ?? 0;
    if (tokens < keepWarm.minTokens) {
        return;
    }
    // A person at the keyboard, not a program holding a token a person minted: only they come back to a warm cache.
    const personUntil = keepWarm.auto && spokenByPerson(settled.speaker) ? now + keepWarm.hours * HOUR_MS : undefined;
    const forSubagents = keepWarm.subagents && childrenAtWorkOf(deps.conversations, conversationId) > 0;
    if (!forSubagents) {
        if (personUntil !== undefined) {
            refusedAfterTurn(deps, conversationId, armKeepWarm(deps, conversationId, personUntil, now));
        }
        return;
    }
    const answer = arm(deps, conversationId, now + SUBAGENTS_REACH_MS, now);
    if ("ok" in answer) {
        deps.conversations.holdings(FOR_SUBAGENTS).hold(conversationId, conversationId, { fallback: personUntil });
    }
    refusedAfterTurn(deps, conversationId, answer);
};

const refusedAfterTurn = (deps: Pick<KeepWarmDeps, "logger">, conversationId: string, answer: KeepWarmAnswer): void => {
    if ("refused" in answer) {
        deps.logger.debug({ conversationId, reason: answer.refused }, "keep-warm: not armed after the turn");
    }
};

/**
 * A hold for subagents none of which is at work any more, looked at as a refresh falls due: it goes on as the person's
 * own hold where one stands behind it, else ends without spending the refresh. Their reports have woken the
 * conversation already (whose turn took the hold), or never will: a child stopped, paused for a reset, or waiting on a
 * person. Answers whether it did either, leaving the hold to be looked at again rather than refreshed now: the person's
 * hold may end before this refresh would be worth sending.
 */
const outlivedSubagents = (deps: KeepWarmDeps, conversationId: string, end: (reason: KeepWarmEnd, detail?: string) => void, now: number): boolean => {
    const { conversations } = deps;
    const held = conversations.holdings(FOR_SUBAGENTS).get(conversationId);
    if (held === undefined || childrenAtWorkOf(conversations, conversationId) > 0) {
        return false;
    }
    conversations.holdings(FOR_SUBAGENTS).drop(conversationId);
    if (held.fallback === undefined || !("ok" in arm(deps, conversationId, held.fallback, now))) {
        end("elapsed", "its subagents are no longer working");
    }
    return true;
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
        heard.failure ??= { kind: "error", message: errorMessage(error) };
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

type ClockLook = { readonly kind: "due" | "wait" } | { readonly kind: "end"; readonly reason: KeepWarmEnd; readonly detail?: string };

// What the cache's clock says of a hold: it is over, nothing is due yet, or a refresh is due now.
const clockLook = (cache: { readonly at: number; readonly ttlMs: number } | undefined, kept: KeepWarm, now: number): ClockLook => {
    if (cache === undefined || cache.at + cache.ttlMs <= now) {
        return { kind: "end", reason: "cold", detail: "it expired before a refresh could run" };
    }
    if (now >= nextPromptDayAt(cache.at)) {
        return { kind: "end", reason: "changed", detail: "the date in the prompt" };
    }
    if (now >= kept.until) {
        return { kind: "end", reason: "elapsed" };
    }
    return cache.at + cache.ttlMs >= kept.until || now < keepWarmDueAt(cache) ? { kind: "wait" } : { kind: "due" };
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
        conversations.holdings(FOR_SUBAGENTS).drop(conversationId);
        conversations.send(conversationId, { kind: "keep-warm-ended", reason, ...opt("detail", detail) }, now);
    };
    const entry = deps.agents.entry(conversationId);
    if (entry === undefined || entry.archivedAt !== undefined) {
        dropKeepWarm(deps, conversationId);
        return;
    }
    // Something is about to run on it, whose own requests keep the cache; a held queue runs nothing until a press, and a
    // booked message nothing until its time.
    if (state.phase.kind !== "idle" || (waitingOf(state.queue).length > 0 && holdOf(state.queue) === undefined)) {
        schedule(deps, conversationId, now + BUSY_RETRY_MS, now);
        return;
    }
    const keepable = conversations.holdings(KEEPABLE).get(conversationId);
    const moved = movedOn(deps, conversationId, keepable);
    if (moved !== undefined || keepable === undefined) {
        end("changed", moved);
        return;
    }
    const look = clockLook(state.turn.promptCache, kept, now);
    if (look.kind === "end") {
        end(look.reason, look.detail);
        return;
    }
    // Subagents are asked only once a refresh is due: until then a hold costs nothing however they fare.
    if (look.kind === "wait" || outlivedSubagents(deps, conversationId, end, now)) {
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

// A turn's first cache reading names the hold it picked up, which the transcript turns into its receipt.
export const keptWarmOf = (services: Pick<Services, "conversations">, conversationId: string | undefined, event: AgentEvent): AgentEvent => {
    if (event.kind !== "prompt_cache" || conversationId === undefined) {
        return event;
    }
    const kept = services.conversations.state(conversationId)?.turn.keptWarm;
    return kept === undefined ? event : { ...event, kept };
};
