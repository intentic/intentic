import { formatTokens } from "@intentic/ui/format";
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
    readonly promptCache?: { readonly at: number; readonly ttlMs: number };
    readonly contextTokens?: number;
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
