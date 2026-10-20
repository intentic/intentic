import type { TurnPulse } from "../turn/turn-pulse.js";
import { type TokenCounts, weightedTokens } from "./burn-weight.js";

/* THE LIVE TOKEN METER: what each running turn spends, as it spends it, and what each account was spent by.

   The spend ledger is written once, from the turn's own final accounting, and a turn a spent allowance cut short has
   none: ten children that had each worked fifty minutes were filed at $0 and no tokens (2026-10-20), so the very turns
   that emptied the window were the ones nothing could learn a rate from. Every request's usage arrives with its
   message long before that, the in-process helpers' included (a third of those children's tokens), and is counted here
   as it arrives: per conversation, for the rate its turn spends at, and per account in minute buckets, for what moved
   an account's window between two readings (burn-rates.ts).

   A runtime that reports usage only at its turn's end is metered then, as one lump (`meterTurnTotal`); a turn that was
   metered live ignores that lump, which would count it twice. Attributed through the turn's pulse (turn-pulse.ts),
   which names the provider, account and model a conversation's running turn is on. In memory: a restart starts the
   rates afresh, which costs the planner its measured rates for the turns that come back until they run a while. */

// How far back a running turn's rate is read: long enough to smooth a burst of cache writes, short enough to follow a
// turn that settled into a cheaper pace.
const RATE_SPAN_MS = 30 * 60_000;
// How long an account's minute buckets are kept: a five-hour window and the slack between two readings of it.
const RETAIN_MS = 8 * 60 * 60_000;
const MINUTE_MS = 60_000;

interface TurnMeter {
    readonly turnId: string;
    readonly provider: string;
    readonly account: string | undefined;
    readonly model: string | undefined;
    readonly startedAt: number;
    total: number;
    // Whether any of it came request by request; a turn metered live ignores its own end-of-turn total.
    live: boolean;
    // The live samples within the rate span, oldest first.
    readonly samples: { readonly at: number; readonly weighted: number }[];
}

const turns = new Map<string, TurnMeter>();
const buckets = new Map<string, Map<number, number>>();

// The meter's key for an account of a provider; a turn whose account is not known is filed under the provider alone.
const accountKey = (provider: string, account: string | undefined): string => `${provider}\u0000${account ?? ""}`;

// The conversation's meter for the turn its pulse names, opened afresh when that turn is a new one.
const meterFor = (pulse: TurnPulse | undefined, now: number): TurnMeter | undefined => {
    if (pulse === undefined) {
        return undefined;
    }
    const kept = turns.get(pulse.conversationId);
    if (kept?.turnId === pulse.turnId) {
        return kept;
    }
    const fresh: TurnMeter = {
        turnId: pulse.turnId,
        provider: pulse.provider,
        account: pulse.account,
        model: pulse.model,
        startedAt: Math.min(pulse.startedAt, now),
        total: 0,
        live: false,
        samples: [],
    };
    turns.set(pulse.conversationId, fresh);
    return fresh;
};

const addToAccount = (meter: TurnMeter, weighted: number, now: number): void => {
    const key = accountKey(meter.provider, meter.account);
    const series = buckets.get(key) ?? new Map<number, number>();
    const minute = Math.floor(now / MINUTE_MS);
    series.set(minute, (series.get(minute) ?? 0) + weighted);
    const oldest = Math.floor((now - RETAIN_MS) / MINUTE_MS);
    for (const at of series.keys()) {
        if (at < oldest) {
            series.delete(at);
        }
    }
    buckets.set(key, series);
};

/** One request's tokens, as the running turn its pulse names spent them. Nothing is metered for a conversation with no turn. */
export const meterTokens = (pulse: TurnPulse | undefined, counts: TokenCounts, now: number = Date.now()): void => {
    const weighted = weightedTokens(counts);
    const meter = weighted > 0 ? meterFor(pulse, now) : undefined;
    if (meter === undefined) {
        return;
    }
    meter.live = true;
    meter.total += weighted;
    meter.samples.push({ at: now, weighted });
    while (meter.samples.length > 0 && (meter.samples[0]?.at ?? now) < now - RATE_SPAN_MS) {
        meter.samples.shift();
    }
    addToAccount(meter, weighted, now);
};

/** A turn's whole accounting, from a runtime that reports none per request; ignored for a turn already metered live. */
export const meterTurnTotal = (pulse: TurnPulse, counts: TokenCounts, now: number = Date.now()): void => {
    const meter = meterFor(pulse, now);
    const weighted = weightedTokens(counts);
    if (meter === undefined || meter.live || weighted <= 0) {
        return;
    }
    meter.total += weighted;
    addToAccount(meter, weighted, now);
};

/** What a conversation's current turn spends per hour, over the last half hour of it, and how long that was measured over. */
export interface TurnRate {
    readonly tokensPerHour: number;
    readonly observedMs: number;
}

export const turnRate = (conversationId: string, now: number = Date.now()): TurnRate | undefined => {
    const meter = turns.get(conversationId);
    if (meter === undefined) {
        return undefined;
    }
    const from = Math.max(meter.startedAt, now - RATE_SPAN_MS);
    const observedMs = Math.max(0, now - from);
    if (observedMs === 0) {
        return { tokensPerHour: 0, observedMs };
    }
    const spent = meter.live ? meter.samples.filter((sample) => sample.at > from).reduce((sum, sample) => sum + sample.weighted, 0) : meter.total;
    const span = meter.live ? observedMs : Math.max(1, now - meter.startedAt);
    return { tokensPerHour: (spent / span) * 3_600_000, observedMs };
};

/** What a turn spent in all, and since when: what its model's rate is learned from once it ends. */
export interface TurnSpend {
    readonly provider: string;
    readonly model: string | undefined;
    readonly startedAt: number;
    readonly weighted: number;
}

export const turnSpend = (conversationId: string, turnId: string): TurnSpend | undefined => {
    const meter = turns.get(conversationId);
    return meter?.turnId === turnId ? { provider: meter.provider, model: meter.model, startedAt: meter.startedAt, weighted: meter.total } : undefined;
};

/** Everything metered on one account of a provider in [from, to), by minute: what moved its window between two readings. */
export const accountTokensBetween = (provider: string, account: string | undefined, from: number, to: number): number => {
    const series = buckets.get(accountKey(provider, account));
    if (series === undefined) {
        return 0;
    }
    const first = Math.floor(from / MINUTE_MS);
    const last = Math.floor(to / MINUTE_MS);
    let sum = 0;
    for (const [minute, weighted] of series) {
        if (minute >= first && minute < last) {
            sum += weighted;
        }
    }
    return sum;
};

/** How far back the meter holds an account's buckets: a reading older than this has nothing to be learned against. */
export const METER_RETAIN_MS = RETAIN_MS;

/** Every meter dropped: a suite's clean slate. */
export const resetTokenMeter = (): void => {
    turns.clear();
    buckets.clear();
};
