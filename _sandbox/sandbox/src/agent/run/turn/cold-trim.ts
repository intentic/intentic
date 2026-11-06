import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import type { HandedOff, HandoffMode } from "@intentic/sandbox-contract/schemas/providers/handoff";
import type { TurnExperimentStamps } from "./turn-plan.js";
import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import { opt } from "../../../opt.js";
import type { Services } from "../../../composition.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import { utcDayOf } from "@intentic/sandbox-contract/time/zone";
import { chainContext, contextOf, estimateCopy, readSessionChain, type SessionLine } from "../../providers/claude/claude-session-copy.js";
import { trimmedTurn } from "../../providers/limit-handoff.js";
import { armOf, EXPERIMENTS } from "../decide/experiments.js";
import { PROMPT_CACHE_1H_MS, ttlFromCacheCreation } from "./prompt-cache.js";

export interface ColdTrimBasis {
    readonly promptCache: { readonly at: number; readonly ttlMs: number } | undefined;
    readonly contextTokens: number | undefined;
}

interface TrimOutcome<T> {
    readonly turn: T;
    readonly event: HandedOff | undefined;
    readonly stamps: TurnExperimentStamps;
}

// The turns a trim can reach, whatever the clock says: an ordinary follow-up of a native Claude session on its own loop.
const coldTrimReaches = (turn: TurnInput, held: boolean): boolean => {
    const { agent, harness } = withRuntimeDefaults(turn);
    return (
        agent === "claude" &&
        capabilitiesOf(agent, harness).runtime === "claude-code" &&
        turn.sessionId !== undefined &&
        turn.conversationId !== undefined &&
        turn.forkOf === undefined &&
        turn.resumeAt === undefined &&
        turn.resume === undefined &&
        !held
    );
};

// Keep-warm refreshes this same clock. Unknown timing never means cold; the extra 30s keeps an expiry edge whole.
export const coldTrimEligible = (
    turn: TurnInput,
    cache: { readonly at: number; readonly ttlMs: number } | undefined,
    tokens: number | undefined,
    threshold: number,
    held: boolean,
    now: number,
): boolean =>
    coldTrimReaches(turn, held) &&
    tokens !== undefined &&
    tokens > threshold &&
    cache !== undefined &&
    Number.isFinite(cache.at) &&
    Number.isFinite(cache.ttlMs) &&
    cache.ttlMs > 0 &&
    now > cache.at + cache.ttlMs + 30_000;

// A basis this process measured itself, off the live turn's context frames. A boot starts every conversation's turn
// readings fresh (conversation-state.ts idleConversation), so the first follow-up after a restart has none: without the
// session file below, every cold resume after a restart carried its whole history (26 of 48 cold resumes over 100k
// tokens, 2026-10-19 to 11-06, all of them after a restart).
const measuredLive = (state: ColdTrimBasis | undefined): state is { promptCache: { at: number; ttlMs: number }; contextTokens: number } =>
    state?.promptCache !== undefined && state.contextTokens !== undefined;

// The same basis read back off the session file the trim reads anyway: the clock runs from the chain's last request
// (a read refreshes the entry as a write does), under the lifetime the newest write in the chain went in under, or the
// longer of Anthropic's two where no write names one, so a guess can only call a cold cache warm. Undefined when the
// chain carries no stamped request to run it from.
export const sessionBasis = (chain: readonly SessionLine[]): ColdTrimBasis | undefined => {
    let at: number | undefined;
    let ttlMs: number | undefined;
    for (let index = chain.length - 1; index >= 0 && (at === undefined || ttlMs === undefined); index -= 1) {
        const entry = chain[index]?.entry;
        if (contextOf(entry) === undefined) {
            continue;
        }
        if (at === undefined) {
            const stamped = Date.parse(String(entry?.["timestamp"] ?? ""));
            if (!Number.isFinite(stamped)) {
                return undefined;
            }
            at = stamped;
        }
        ttlMs ??= ttlFromCacheCreation(entry?.message?.usage?.cache_creation ?? undefined);
    }
    return at === undefined ? undefined : { promptCache: { at, ttlMs: ttlMs ?? PROMPT_CACHE_1H_MS }, contextTokens: chainContext(chain) };
};

// A keep-warm refresh forks the session, so the session file never shows it, and one sent before the restart may still
// hold the cache open: the ledger row it left (cache-keepwarm.ts recordRefresh) moves the clock forward.
const refreshedSince = async (services: Services, conversationId: string, basis: ColdTrimBasis): Promise<ColdTrimBasis> => {
    const cache = basis.promptCache;
    if (cache === undefined) {
        return basis;
    }
    const rows = await services.usage.turns({ from: utcDayOf(cache.at) });
    const latest = rows.reduce(
        (newest, row) => (row.purpose === "keep-warm" && row.conversationId === conversationId && row.outcome === "ok" ? Math.max(newest, row.at) : newest),
        cache.at,
    );
    return { ...basis, promptCache: { ...cache, at: latest } };
};

// Both arms inspect the same session before assignment is stamped. Compacted transcripts stay whole until their
// boundary/summary ancestry is supported here; a missing file or a copy that would clear nothing is no experiment.
export const coldTrimTurn = async <T extends TurnInput>(
    services: Services,
    turn: T,
    settings: SandboxSettings,
    held: boolean,
    state: ColdTrimBasis | undefined,
): Promise<TrimOutcome<T> | undefined> => {
    const live = measuredLive(state);
    // The whole check before any file is read when this process measured the clock; the rest of it once the session
    // file has given it back.
    const cold = (basis: ColdTrimBasis | undefined): boolean =>
        coldTrimEligible(turn, basis?.promptCache, basis?.contextTokens, settings.coldTrimMinTokens, held, Date.now());
    if (!settings.coldTrim || !(live ? cold(state) : coldTrimReaches(turn, held))) {
        return undefined;
    }
    try {
        const entry = services.agents.entry(turn.conversationId!);
        if (entry?.sessionId !== turn.sessionId) {
            return undefined;
        }
        const store = services.agentWorktrees.sessionStore(entry);
        const read = await readSessionChain(store, turn.sessionId!, false);
        if (read === undefined || read.compacted) {
            return undefined;
        }
        // A refresh can only make a cold clock warm, so the ledger is read only for a session that reads cold on its own.
        const fromFile = live ? state : sessionBasis(read.chain);
        const basis = live || fromFile === undefined || !cold(fromFile) ? fromFile : await refreshedSince(services, turn.conversationId!, fromFile);
        if (!cold(basis) || (estimateCopy(read.chain, basis?.contextTokens)?.cleared ?? 0) === 0) {
            return undefined;
        }
        const arm = armOf(EXPERIMENTS.coldTrim, settings, turn.conversationId);
        if (arm === false) {
            return { turn, event: undefined, stamps: EXPERIMENTS.coldTrim.stamps({ arm }) };
        }
        const trimmed = await trimmedTurn(services, turn, basis, { dropUnanswered: false });
        return {
            ...trimmed,
            stamps: EXPERIMENTS.coldTrim.stamps({ arm, ...opt("cleared", trimmed.event.fellBack ? undefined : trimmed.event.cleared) }),
        };
    } catch (error) {
        services.logger.warn({ err: error, conversationId: turn.conversationId }, "cold trim: could not inspect the session, carrying it whole");
        return undefined;
    }
};

// One copy path before the runtime probe: a held hand-off owns its choice, ordinary follow-ups may enter the experiment.
// `way` is how this turn goes on from the held turn it replaces (handoff-way.ts). A re-run drops the message nobody
// answered, which it sends again; new words taking the held turn's place keep it, since nothing sends it again.
export const resumeTrimTurn = async <T extends TurnInput>(
    services: Services,
    turn: T,
    settings: SandboxSettings,
    held: { readonly contextTokens?: number | undefined } | undefined,
    basis: ColdTrimBasis | undefined,
    way: HandoffMode | undefined,
): Promise<TrimOutcome<T> & { readonly cold: boolean }> => {
    if (way === "trim") {
        return { ...(await trimmedTurn(services, turn, held, { dropUnanswered: turn.resume === "trimmed" })), stamps: {}, cold: false };
    }
    const cold = await coldTrimTurn(services, turn, settings, held !== undefined, basis);
    return { turn: cold?.turn ?? turn, event: cold?.event, stamps: cold?.stamps ?? {}, cold: cold !== undefined };
};

// A copy on disk is not delivery: only a session the runtime resumes cleared this turn's history.
export const trimDelivery = <T extends TurnInput>(trim: TrimOutcome<T> & { readonly cold: boolean }, resumed: string | undefined): TrimOutcome<T> => {
    if (!trim.cold || resumed === trim.turn.sessionId) {
        return trim;
    }
    const stamps = { ...trim.stamps };
    delete stamps.coldTrimmed;
    return { turn: trim.turn, stamps, event: trim.event === undefined ? undefined : { mode: "trim", fellBack: true } };
};
