import { type CacheClock, type KeepWarm, keepWarmCap, keepWarmLeadMs, keepWarmRefreshes } from "@intentic/sandbox-contract";
import { formatClock, formatTokens } from "@intentic/ui/format";
import { type AgentStanding, formatElapsed, laneOf, turnInFlight } from "./agentStatus";
import { t } from "@intentic/ui/i18n";

// Whether picking a conversation up is about to stop being cheap. The daemon publishes a deadline
// (AgentSummary.promptCache) only for providers whose cache lifetime it could ground in a measurement or a documented
// rule, so no deadline means nobody knows, never that the cache is cold.

// How much of a cache's life is left when it becomes worth mentioning. A fraction rather than a fixed lead: a minute is
// the whole of a five-minute entry and nothing of an hour's.
export const COOLING_FRACTION = 0.2;

// Everything the reading takes: a standing to place the card by, plus the two facts the daemon measured.
export interface CacheStanding extends AgentStanding {
    readonly promptCache?: { readonly at: number; readonly ttlMs: number; readonly rollsAt?: number; readonly keepable?: boolean };
    readonly contextTokens?: number;
    readonly keepWarm?: KeepWarm;
}

export interface CacheCooling {
    readonly text: string;
    readonly countdown: string;
    readonly hint: string;
    // Whether the warning's own window is more than half gone. The chip is drawn quietly until this turns true: the
    // whole point is a nudge, and something that arrives loud is an alarm about money nobody has spent yet.
    readonly near: boolean;
}

// The cards a mark can appear on at all: not mid-turn, whose own requests refresh the entry faster than any countdown
// could report it, and not one the user is finished with. Shared, so the clock gate and the chip cannot drift apart.
const markable = (agent: CacheStanding): boolean => !turnInFlight(agent) && laneOf(agent) !== `finished`;

// Whether a chip is still ahead for this card, which is what the card's clock has to be running for it to appear on the
// minute it should. Read like `limitClosed`, off the caller's own instant rather than the shared tick: the roster frame
// that ends a turn is what re-evaluates it, and that frame is exactly when a new deadline is set.
export const cacheWarm = (agent: CacheStanding, now: number = Date.now()): boolean =>
    agent.promptCache !== undefined && agent.promptCache.at + agent.promptCache.ttlMs > now && markable(agent);

// A hold still running, as opposed to one that ended or none at all.
export const keptWarm = (agent: CacheStanding): KeepWarm | undefined => (agent.keepWarm?.ended === undefined ? agent.keepWarm : undefined);

// Alive as the provider sees it, whatever lane the card sits in: the nudge is gated by lane, the cache is not.
export const cacheAlive = (agent: CacheStanding, now: number): boolean =>
    agent.promptCache !== undefined && agent.promptCache.at + agent.promptCache.ttlMs > now && !turnInFlight(agent);

/** Whether a hold can be offered: a cache the daemon can replay, still alive, between turns, before the date rolls. */
export const warmOffer = (agent: CacheStanding, now: number): boolean =>
    agent.promptCache?.keepable === true && cacheAlive(agent, now) && (agent.promptCache.rollsAt === undefined || agent.promptCache.rollsAt > now);

export interface WarmChoice {
    readonly hours: number;
    readonly until: number;
    readonly refreshes: number;
    // Shortened below what was asked: the date changes first, or refreshing that long would cost more than it saves.
    readonly capped: boolean;
}

// Presets a press offers, each cut at what can honestly be kept; two presets the cut makes equal collapse into the first.
export const warmChoices = (
    cache: CacheClock & { readonly rollsAt?: number },
    now: number,
    spent = 0,
    hours: readonly number[] = [1, 2, 4, 8],
): WarmChoice[] => {
    const cap = keepWarmCap(cache, cache.rollsAt, spent);
    const seen = new Set<number>();
    return hours.flatMap((count) => {
        const asked = now + count * 3_600_000;
        const until = Math.min(asked, cap);
        if (until <= now || seen.has(until)) {
            return [];
        }
        seen.add(until);
        return [{ hours: count, until, refreshes: keepWarmRefreshes(cache, until), capped: until < asked }];
    });
};

/** How many minutes apart a hold's refreshes run. */
export const refreshMinutes = (ttlMs: number): number => Math.round((ttlMs - keepWarmLeadMs(ttlMs)) / 60_000);

export interface WarmMark {
    readonly icon: `sun` | `moon`;
    readonly text: string;
    readonly hint: string;
    // A hold that ended for a reason worth reading; an elapsed one is not drawn at all.
    readonly cold: boolean;
}

/** The card's mark for a hold, on every lane since a hold spends allowance; undefined for none and for one that ran its course. */
export const warmMark = (agent: CacheStanding): WarmMark | undefined => {
    const hold = agent.keepWarm;
    if (hold === undefined) {
        return undefined;
    }
    if (hold.ended === undefined) {
        const read = hold.readTokens === undefined ? `` : t(`agents.promptCache.lastRead`, { tokens: formatTokens(hold.readTokens) });
        return {
            icon: `sun`,
            text: t(`agents.promptCache.warmUntil`, { time: formatClock(hold.until) }),
            hint: t(`agents.promptCache.keptWarmHint`, { time: formatClock(hold.until), refreshes: hold.refreshes, read }),
            cold: false,
        };
    }
    if (hold.ended.reason === `elapsed`) {
        return undefined;
    }
    return {
        icon: `moon`,
        text: t(`agents.promptCache.coldSince`, { time: formatClock(hold.ended.at) }),
        hint: endedLine(hold.ended),
        cold: true,
    };
};

/** Why a hold stopped, in a sentence, with the daemon's specifics where it gave any. */
export const endedLine = (ended: NonNullable<KeepWarm[`ended`]>): string => {
    const reason = t(`agents.promptCache.ended.${ended.reason}`);
    return ended.detail === undefined ? reason : `${reason} (${ended.detail})`;
};

// Phrase and clock in the watch line's grammar, so the board has one shape for "this card is on a timer". Undefined for
// everything a person cannot act on: a cache nobody measured, one with time to spare, one already cold, and the cards
// `markable` rules out.
export const cacheCooling = (agent: CacheStanding, now: number): CacheCooling | undefined => {
    const cache = agent.promptCache;
    if (cache === undefined || !markable(agent)) {
        return undefined;
    }
    const deadline = cache.at + cache.ttlMs;
    const left = deadline - now;
    const window = cache.ttlMs * COOLING_FRACTION;
    if (left <= 0 || left > window) {
        return undefined;
    }
    const countdown = formatElapsed(now, deadline);
    // Named in tokens, never dollars: the rate depends on a model price list this app does not carry.
    const read =
        agent.contextTokens === undefined ? `everything it has already read` : `the ${formatTokens(agent.contextTokens)} tokens it has already read`;
    return {
        text: `Cooling`,
        countdown,
        near: left <= window / 2,
        hint: t(`agents.promptCache.promptCacheGoesCold`, { countdown, read }),
    };
};
