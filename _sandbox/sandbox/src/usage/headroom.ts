import type { AccountUsage, AgentProvider, UsageWindow } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { AccountUsageStore } from "./account-usage.js";

// One headroom service for every provider: readings are triggered by what happened (a turn settling, a refusal, a
// screen opening, a re-measure press) via `refresh(scope, maxAge)`, not on a timer, with an idle floor (`start`) for a
// quiet sandbox. A source contributes targets (account + reader); every landed reading is announced via `onChange`.

export interface HeadroomReading {
    readonly windows: readonly UsageWindow[];
    // Endpoint's own stay-away on a 429, in ms; must not be retried on the next trigger while it holds.
    readonly retryAfterMs?: number;
}

export interface HeadroomTarget {
    // Account's key in the shared store: a Claude account id, or `${provider}:${authFile}` for a routed one.
    readonly key: string;
    readonly provider: AgentProvider;
    // Never throws for an ordinary failure; an empty window list means "could not read", keeps the last snapshot.
    readonly read: () => Promise<HeadroomReading>;
}

export interface HeadroomSource {
    readonly targets: () => Promise<readonly HeadroomTarget[]>;
}

export interface RefreshScope {
    // Only these providers' targets; absent means every provider.
    readonly providers?: readonly AgentProvider[];
    // Only this account's target; absent means every account in scope.
    readonly account?: string;
}

export interface RefreshOptions {
    readonly scope?: RefreshScope;
    // How old a reading may be before another round-trip is worth it; 0 means something just happened.
    readonly maxAgeMs?: number;
    // Resolve after this long even without a landed read; a waiting page gets what it has, else the sweep.
    readonly withinMs?: number;
}

export interface HeadroomService {
    readonly refresh: (options?: RefreshOptions) => Promise<void>;
    // Records a reading obtained elsewhere (a turn's stream, a provider's push) exactly as a swept one; provider rides
    // along since the store key alone doesn't say whose row it is.
    readonly record: (provider: AgentProvider, account: string, usage: AccountUsage) => Promise<void>;
    readonly clear: (provider: AgentProvider, account: string) => Promise<void>;
    readonly read: AccountUsageStore["read"];
    // Fires on every write, with the account's new snapshot, or undefined when cleared.
    readonly onChange: (listener: (provider: AgentProvider, account: string, usage: AccountUsage | undefined) => void) => () => void;
    // Idle floor: one sweep now, then one whenever a reading has gone `idleMs` without a trigger.
    readonly start: (idleMs?: number) => () => void;
}

// Under this, a reading is current enough that another round-trip tells us nothing new.
export const FRESH_MS = 60_000;
// Idle floor: long, since anything that changes a reading already triggers its own read.
const IDLE_MS = 15 * 60_000;
// Bounds parallel reads so a refresh across dozens of accounts doesn't self-inflict a rate limit.
const CONCURRENCY = 4;

const deadline = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        // Unref'd: a caller that stopped waiting must not hold the process open until this fires.
        setTimeout(resolve, ms).unref();
    });

export const createHeadroomService = (deps: {
    readonly store: AccountUsageStore;
    readonly sources: readonly HeadroomSource[];
    readonly logger: Logger;
}): HeadroomService => {
    // When each target was last asked, not answered; bounds retries of a failing read the store can't cache.
    const attemptedAt = new Map<string, number>();
    // Endpoint's stay-away per target, honoured even by a forced trigger.
    const blockedUntil = new Map<string, number>();
    // Read in flight per target, so concurrent triggers share one round-trip.
    const inFlight = new Map<string, Promise<void>>();
    const listeners = new Set<(provider: AgentProvider, account: string, usage: AccountUsage | undefined) => void>();

    const announce = (provider: AgentProvider, account: string, usage: AccountUsage | undefined): void => {
        for (const listener of listeners) {
            try {
                listener(provider, account, usage);
            } catch (error) {
                deps.logger.warn({ err: error, account }, "headroom: a change listener threw");
            }
        }
    };

    const record = async (provider: AgentProvider, account: string, usage: AccountUsage): Promise<void> => {
        await deps.store.record(account, usage);
        announce(provider, account, usage);
    };

    const readOne = (target: HeadroomTarget): Promise<void> => {
        const running = inFlight.get(target.key);
        if (running !== undefined) {
            return running;
        }
        const read = (async (): Promise<void> => {
            attemptedAt.set(target.key, Date.now());
            const reading = await target.read();
            if (reading.retryAfterMs !== undefined) {
                blockedUntil.set(target.key, Date.now() + reading.retryAfterMs);
                return;
            }
            // A failed or poolless read leaves the last snapshot standing; an empty list would misread as "no limits".
            if (reading.windows.length > 0) {
                await record(target.provider, target.key, { windows: [...reading.windows], measuredAt: Date.now() });
            }
        })()
            .catch((error: unknown) => deps.logger.warn({ err: error, account: target.key }, "headroom: read failed, the next trigger retries"))
            .finally(() => inFlight.delete(target.key));
        inFlight.set(target.key, read);
        return read;
    };

    const inScope = (target: HeadroomTarget, scope: RefreshScope | undefined): boolean =>
        (scope?.providers === undefined || scope.providers.includes(target.provider)) && (scope?.account === undefined || scope.account === target.key);

    const sweep = async (options: RefreshOptions): Promise<void> => {
        const maxAgeMs = options.maxAgeMs ?? FRESH_MS;
        const [targets, stored] = await Promise.all([
            Promise.all(deps.sources.map((source) => source.targets().catch(() => []))).then((lists) => lists.flat()),
            deps.store.read(),
        ]);
        const now = Date.now();
        const due = targets.filter(
            (target) =>
                inScope(target, options.scope) &&
                (blockedUntil.get(target.key) ?? 0) <= now &&
                // `>=`, so a bound of zero reads it regardless of the clock, as the caller meant.
                now - Math.max(stored[target.key]?.measuredAt ?? 0, attemptedAt.get(target.key) ?? 0) >= maxAgeMs,
        );
        const pending = [...due];
        const worker = async (): Promise<void> => {
            for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
                await readOne(next);
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
    };

    // Never rejects: an account list must not fail because a quota read did.
    const refresh = (options: RefreshOptions = {}): Promise<void> => {
        const pending = sweep(options).catch((error: unknown) => deps.logger.warn({ err: error }, "headroom: sweep failed, the next trigger retries"));
        return options.withinMs === undefined ? pending : Promise.race([pending, deadline(options.withinMs)]);
    };

    return {
        refresh,
        record,
        clear: async (provider, account) => {
            attemptedAt.delete(account);
            blockedUntil.delete(account);
            await deps.store.clear(account);
            announce(provider, account, undefined);
        },
        read: deps.store.read,
        onChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        start: (idleMs = IDLE_MS) => {
            const timer = setInterval(() => void refresh({ maxAgeMs: idleMs }), idleMs);
            // Unref'd like the daemon's other loops: a background refresh must never hold the process open.
            timer.unref();
            void refresh();
            return () => clearInterval(timer);
        },
    };
};
