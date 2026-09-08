import { type AccountUsage, gatingWindows, type ModelRef, SPENT_UTILIZATION, type UsageWindow } from "@intentic/sandbox-contract";

// What the recorded quota says about a provider's fleet for one model. `withHeadroom` separates a real refusal from
// CLIProxyAPI cooling a credential for another reason, since a fleet-wide proxy makes every refusal look quota-shaped.
// Scoped to the pools this model spends; both counts zero means unmeasured.

export interface FleetReading {
    readonly account: string;
    readonly usage: AccountUsage | undefined;
    // Translator's own bench; counts as spent with the proxy's retry as its reset, the more current fact.
    readonly cooling?: { readonly until?: number | undefined; readonly reason?: string | undefined } | undefined;
}

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

const judge = (reading: FleetReading, model: ModelRef | undefined): Verdict => {
    if (reading.cooling !== undefined) {
        return { kind: "spent", exhausted: [{ resetsAt: reading.cooling.until, pool: undefined }] };
    }
    const windows = gatingWindows(reading.usage, model);
    if (windows.length === 0) {
        return { kind: "unmeasured" };
    }
    const full = windows.filter((window) => window.utilization >= SPENT_UTILIZATION);
    return full.length === 0 ? { kind: "room", measuredAt: reading.usage?.measuredAt ?? 0 } : { kind: "spent", exhausted: full.map(exhaustedPool) };
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
