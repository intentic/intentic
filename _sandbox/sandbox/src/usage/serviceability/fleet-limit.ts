import { gatingWindows, type ModelRef, type ServiceFacts, serviceState, SPENT_UTILIZATION, type UsageWindow } from "@intentic/sandbox-contract";

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

// A blocked account reopens only when its bench lifts (`until`), and never by a wait otherwise; a spent one names the
// full pools this model spends, the only ones worth naming.
const judge = (reading: FleetReading, model: ModelRef | undefined): Verdict => {
    const state = serviceState(reading, undefined, model);
    switch (state.kind) {
        case "blocked":
            return { kind: "spent", exhausted: [{ resetsAt: state.until, pool: undefined }] };
        case "spent":
            return {
                kind: "spent",
                exhausted: gatingWindows(reading.usage, model)
                    .filter((window) => window.utilization >= SPENT_UTILIZATION)
                    .map(exhaustedPool),
            };
        case "ready":
            return { kind: "room", measuredAt: reading.usage?.measuredAt ?? 0 };
        case "unknown":
            return { kind: "unmeasured" };
    }
};

export const fleetLimit = (readings: readonly FleetReading[], model: ModelRef | undefined): TurnLimit => {
    const verdicts = readings.map((reading) => judge(reading, model));
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
