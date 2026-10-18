import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import type { HandedOff } from "@intentic/sandbox-contract/schemas/providers/handoff";
import type { TurnExperimentStamps } from "./turn-plan.js";
import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import { opt } from "../../../opt.js";
import type { Services } from "../../../composition.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import { estimateCopy, readSessionChain } from "../../providers/claude/claude-session-copy.js";
import { trimmedTurn } from "../../providers/limit-handoff.js";
import { armOf, EXPERIMENTS } from "../decide/experiments.js";

export interface ColdTrimBasis {
    readonly promptCache: { readonly at: number; readonly ttlMs: number } | undefined;
    readonly contextTokens: number | undefined;
}

interface TrimOutcome<T> {
    readonly turn: T;
    readonly event: HandedOff | undefined;
    readonly stamps: TurnExperimentStamps;
}

// Keep-warm refreshes this same clock. Unknown timing never means cold; the extra 30s keeps an expiry edge whole.
export const coldTrimEligible = (
    turn: TurnInput,
    cache: { readonly at: number; readonly ttlMs: number } | undefined,
    tokens: number | undefined,
    threshold: number,
    held: boolean,
    now: number,
): boolean => {
    const { agent, harness } = withRuntimeDefaults(turn);
    return (
        agent === "claude" &&
        capabilitiesOf(agent, harness).runtime === "claude-code" &&
        turn.sessionId !== undefined &&
        turn.conversationId !== undefined &&
        turn.forkOf === undefined &&
        turn.resumeAt === undefined &&
        turn.resume === undefined &&
        !held &&
        tokens !== undefined &&
        tokens > threshold &&
        cache !== undefined &&
        Number.isFinite(cache.at) &&
        Number.isFinite(cache.ttlMs) &&
        cache.ttlMs > 0 &&
        now > cache.at + cache.ttlMs + 30_000
    );
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
    if (!settings.coldTrim || !coldTrimEligible(turn, state?.promptCache, state?.contextTokens, settings.coldTrimMinTokens, held, Date.now())) {
        return undefined;
    }
    try {
        const entry = services.agents.entry(turn.conversationId!);
        if (entry?.sessionId !== turn.sessionId) {
            return undefined;
        }
        const store = services.agentWorktrees.sessionStore(entry);
        const read = await readSessionChain(store, turn.sessionId!, false);
        if (read === undefined || read.compacted || (estimateCopy(read.chain, state?.contextTokens)?.cleared ?? 0) === 0) {
            return undefined;
        }
        const arm = armOf(EXPERIMENTS.coldTrim, settings, turn.conversationId);
        if (arm === false) {
            return { turn, event: undefined, stamps: EXPERIMENTS.coldTrim.stamps({ arm }) };
        }
        const trimmed = await trimmedTurn(services, turn, state, { dropUnanswered: false });
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
export const resumeTrimTurn = async <T extends TurnInput>(
    services: Services,
    turn: T,
    settings: SandboxSettings,
    held: { readonly contextTokens?: number | undefined } | undefined,
    basis: ColdTrimBasis | undefined,
): Promise<TrimOutcome<T> & { readonly cold: boolean }> => {
    if (turn.resume === "trimmed") {
        return { ...(await trimmedTurn(services, turn, held)), stamps: {}, cold: false };
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
