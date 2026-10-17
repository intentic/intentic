import type { AccountState, UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import {
    gatingWindows,
    type ModelRef,
    type RefusalsOnFile,
    type ServiceFacts,
    serviceStates,
    SPENT_UTILIZATION,
} from "@intentic/sandbox-contract/models/plan-pools";
import { latestOf } from "../reset-sentences.js";

// What the recorded quota says about a provider's fleet for one model. `withHeadroom` separates a real refusal from
// CLIProxyAPI cooling a credential for another reason, since a fleet-wide proxy makes every refusal look quota-shaped.
// Scoped to the pools this model spends; both counts zero means unmeasured. Each account is judged by the one
// serviceability rule (`serviceState`), so a revoked sign-in, a lost seat and a bench count as nothing to spend.

// An account as the rule reads it: its reading, and whatever marks the reader holds (a translator bench, a revoke, a seat).
export type FleetReading = ServiceFacts;

export interface TurnLimit {
    // Exhausted pool's name; absent when the plan sells one undivided allowance, so there's no pool to name.
    readonly pool?: string;
    readonly spent: number;
    readonly withHeadroom: number;
    // Set only when nothing has headroom; with headroom on file the pool isn't the blocker.
    readonly reopensAt?: number;
    // Newest reading among accounts with headroom (epoch ms); lets a fresher reading outrank an older refusal.
    readonly roomMeasuredAt?: number;
}

// One spent thing: its reopen instant where known, and the pool to name where there is one.
interface Exhausted {
    readonly resetsAt: number | undefined;
    readonly pool: string | undefined;
}

// A pool worth naming is one the plan scopes; the undivided allowance is just "the allowance".
const exhaustedPool = (window: UsageWindow): Exhausted => ({ resetsAt: window.resetsAt, pool: window.gates === "all" ? undefined : window.label });

// Exhausted entry with the soonest reset, since any one account reopening unblocks the turn; an entry with no instant
// only wins when nothing names one.
const soonestOf = (exhausted: readonly Exhausted[]): Exhausted | undefined =>
    exhausted.reduce<Exhausted | undefined>(
        (best, entry) =>
            best === undefined || (entry.resetsAt !== undefined && (best.resetsAt === undefined || entry.resetsAt < best.resetsAt)) ? entry : best,
        undefined,
    );

// One account's verdict: unmeasured, room (with when), or spent (with every full pool); a value so the tally below
// folds rather than branches.
type Verdict = { readonly kind: "unmeasured" } | { readonly kind: "room"; readonly measuredAt: number } | { readonly kind: "spent"; readonly exhausted: readonly Exhausted[] };

// The pools this model spends that read full on the account.
const fullPools = (reading: FleetReading, model: ModelRef | undefined): readonly UsageWindow[] =>
    gatingWindows(reading.usage, model).filter((window) => window.utilization >= SPENT_UTILIZATION);

// When an account is open again for this model: once EVERY full pool it spends has reopened, so the latest of them, and
// never before a bench on it lifts. A bench is the translator's own retry, a floor rather than the reopening: a Kimi
// credential benched for thirty minutes with its five-hour window two hours from reopening was re-run at thirty minutes
// and refused again (2026-10-17). Named by the pool that reopens last, the one actually holding it.
const accountReopening = (full: readonly UsageWindow[], floor: number | undefined, fallback: number | undefined): Exhausted => {
    const last = full.reduce<UsageWindow | undefined>(
        (latest, window) => (window.resetsAt !== undefined && (latest?.resetsAt === undefined || window.resetsAt > latest.resetsAt) ? window : latest),
        undefined,
    );
    const pool = last ?? full[0];
    return { resetsAt: latestOf(floor, last?.resetsAt ?? fallback), pool: pool === undefined ? undefined : exhaustedPool(pool).pool };
};

// A blocked account reopens only when its bench lifts (`until`) and its full pools have reopened, and never by a wait
// otherwise; a spent one when its full pools this model spends have, or, spent by a standing refusal the reading does
// not show, at the instant the provider itself said to try again.
const judge = (reading: FleetReading, state: AccountState, model: ModelRef | undefined): Verdict => {
    switch (state.kind) {
        case "blocked":
            return {
                kind: "spent",
                exhausted: [state.until === undefined ? { resetsAt: undefined, pool: undefined } : accountReopening(fullPools(reading, model), state.until, undefined)],
            };
        case "spent":
            return { kind: "spent", exhausted: [accountReopening(fullPools(reading, model), undefined, state.reopensAt)] };
        case "ready":
            return { kind: "room", measuredAt: reading.usage?.measuredAt ?? 0 };
        case "unknown":
            return { kind: "unmeasured" };
    }
};

/** The fleet's verdict for one model; `refusals` are the provider's refusals on file, each standing until something answers it. */
export const fleetLimit = (readings: readonly FleetReading[], model: ModelRef | undefined, refusals?: RefusalsOnFile): TurnLimit => {
    const states = serviceStates(readings, refusals, model);
    const verdicts = readings.map((reading) => judge(reading, states.get(reading.account) ?? { kind: "unknown" }, model));
    const room = verdicts.flatMap((verdict) => (verdict.kind === "room" ? [verdict.measuredAt] : []));
    const exhausted = verdicts.flatMap((verdict) => (verdict.kind === "spent" ? verdict.exhausted : []));
    const spent = verdicts.filter((verdict) => verdict.kind === "spent").length;
    const soonest = soonestOf(exhausted);
    return {
        ...(soonest?.pool === undefined ? {} : { pool: soonest.pool }),
        spent,
        withHeadroom: room.length,
        ...(room.length > 0 || soonest?.resetsAt === undefined ? {} : { reopensAt: soonest.resetsAt }),
        ...(room.length === 0 ? {} : { roomMeasuredAt: Math.max(...room) }),
    };
};

/**
 * The verdict a gate and the listing share: whether a model is out of allowance on every account, read from the same
 * facts and refusals the account rows publish. An account nothing has measured may still answer, so it keeps the model
 * askable. Two readings of one question drifted before: the spawn gate read Claude's bare usage with no refusal, the
 * listing read seat marks and the refusals on file, and each could call spent what the other let through.
 */
export const askableLimit = (readings: readonly FleetReading[], model: ModelRef | undefined, refusals?: RefusalsOnFile): TurnLimit => {
    const limit = fleetLimit(readings, model, refusals);
    if (limit.spent + limit.withHeadroom >= readings.length) {
        return limit;
    }
    const { reopensAt: _closed, ...open } = limit;
    return { ...open, withHeadroom: limit.withHeadroom + 1 };
};
