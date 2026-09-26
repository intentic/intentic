import type { AccountUsage, AgentProvider, UsageWindow } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { AccountUsageStore } from "./account-usage.js";
import type { ParkedRead, UsageParkStore } from "./usage-parks.js";

// One headroom service for every provider: readings are triggered by what happened (a turn settling, a refusal, a
// screen opening, a re-measure press) via `refresh(scope, maxAge)`, not on a timer, with an idle floor (`start`) for a
// quiet sandbox. A source contributes targets (account + reader); every landed reading is announced via `onChange`.

export interface HeadroomReading {
    readonly windows: readonly UsageWindow[];
    // Endpoint's own stay-away on a 429, in ms; must not be retried on the next trigger while it holds.
    readonly retryAfterMs?: number;
    // A read that succeeded and found no pools, as against one that failed. The only thing that may retire a snapshot:
    // without it a source whose pools come and go (observed-limits.ts) can never take one back.
    readonly empty?: boolean;
    // Why a read that found nothing failed, in the provider's words. Optional because every failure is recorded whether
    // or not the reader could say why (readOne): this only improves the words.
    readonly failure?: string;
}

export interface HeadroomTarget {
    // Account's key in the shared store: a Claude account id, or `${provider}:${authFile}` for a routed one.
    readonly key: string;
    readonly provider: AgentProvider;
    // Never throws for an ordinary failure; an empty window list means "could not read", keeps the last snapshot.
    readonly read: () => Promise<HeadroomReading>;
    // This endpoint's own read budget: the shortest interval a background trigger may re-read it at, whatever
    // freshness that trigger asked for. A re-measure someone is watching (`maxAgeMs: 0`) is not held to it.
    readonly minAgeMs?: number;
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
    // Someone pressed something and is watching the number: the only thing that spends a target's own read budget
    // (`minAgeMs`) ahead of schedule. Never set by an automatic trigger, however fresh it wants the reading — a
    // refusal, a settled turn and a warm-up all recur on their own, and together they outrun any endpoint's budget.
    readonly watched?: boolean;
}

/** An account whose provider is holding reads off, and the instant it may be asked again. */
export interface HeldTarget {
    readonly provider: AgentProvider;
    readonly account: string;
    // Epoch ms; the endpoint's own retry-after, so a screen can say when the number can move.
    readonly until: number;
}

export interface HeadroomService {
    readonly refresh: (options?: RefreshOptions) => Promise<void>;
    // Targets a provider is currently rate-limiting; what a re-measure could not read, and why nothing moved.
    readonly held: () => readonly HeldTarget[];
    // Whether this account's provider is holding reads off right now, for a reader of the same endpoint that does not
    // come through the sweep (claude-limit-reset.ts). Without it the park bounds one caller and the other spends the
    // budget it was protecting.
    readonly parked: (account: string) => Promise<boolean>;
    // Arms the same park from such a reader's own 429, so one refusal is honoured by every caller.
    readonly park: (provider: AgentProvider, account: string, forMs: number) => Promise<void>;
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
    readonly parks: UsageParkStore;
    readonly sources: readonly HeadroomSource[];
    readonly logger: Logger;
}): HeadroomService => {
    // When each target was last asked, not answered; bounds retries of a failing read the store can't cache.
    const attemptedAt = new Map<string, number>();
    // Endpoint's stay-away per target, honoured even by a watched trigger. Mirrors the park store so `held` can answer
    // without a round trip; the store is the authority across restarts.
    const blockedUntil = new Map<string, ParkedRead>();
    // Read in flight per target, so concurrent triggers share one round-trip.
    const inFlight = new Map<string, Promise<void>>();
    const listeners = new Set<(provider: AgentProvider, account: string, usage: AccountUsage | undefined) => void>();

    // Reads the parks from disk once per process, before the first sweep decides anything: a boot sweep that ran ahead
    // of them would ask the very account the provider is refusing.
    let seeded: Promise<void> | undefined;
    const seed = (): Promise<void> =>
        (seeded ??= deps.parks
            .read()
            .then((stored) => {
                for (const [account, parked] of Object.entries(stored)) {
                    blockedUntil.set(account, parked);
                }
            })
            .catch((error: unknown) => deps.logger.warn({ err: error }, "headroom: parked reads could not be loaded, this process will re-earn them")));

    const parkUntil = async (provider: AgentProvider, account: string, until: number): Promise<void> => {
        blockedUntil.set(account, { provider, until });
        await deps.parks.record(account, { provider, until });
    };

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

    // Any attempt that did not land a reading, whatever stopped it, stamped on the snapshot it failed to replace. One
    // path for every failure, known or not: a screen that dates readings by age reads this one fact instead of keeping
    // its own list of the ways a number can stop moving, which is the list that went stale each time a provider found a
    // new way to say no. Logged and announced when the reason changes, not on every retry.
    const failedReasons = new Map<string, string>();
    const readFailed = async (target: HeadroomTarget, reason: string): Promise<void> => {
        const marked = await deps.store.markUnread(target.key, { since: Date.now(), reason });
        if (failedReasons.get(target.key) === reason) {
            return;
        }
        failedReasons.set(target.key, reason);
        deps.logger.warn(
            { account: target.key, provider: target.provider, reason, lastReadAt: marked === undefined ? undefined : new Date(marked.measuredAt).toISOString() },
            "headroom: this account's plan limits could not be re-read, its last reading stands until a read succeeds",
        );
        if (marked !== undefined) {
            announce(target.provider, target.key, marked);
        }
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
                const until = Date.now() + reading.retryAfterMs;
                await parkUntil(target.provider, target.key, until);
                // Said out loud: a reading that silently stops moving is the one failure nobody can see from a screen.
                deps.logger.warn(
                    { account: target.key, provider: target.provider, until: new Date(until).toISOString() },
                    "headroom: the provider is rate-limiting this account, holding reads off until then",
                );
                await readFailed(target, reading.failure ?? "the provider is rate-limiting reads");
                return;
            }
            // A failed read leaves the last snapshot standing; an empty list alone would misread as "no limits". Only a
            // read that says it found nothing retires one, and only when there was one to retire — announcing an
            // absence nobody was shown would redraw every open window each sweep.
            if (reading.windows.length > 0) {
                failedReasons.delete(target.key);
                await record(target.provider, target.key, { windows: [...reading.windows], measuredAt: Date.now() });
                return;
            }
            if (reading.empty === true) {
                failedReasons.delete(target.key);
                // `read()` has already dropped windows that have reset, so a key still present is a reading someone was
                // actually shown — the only case worth announcing an absence for.
                if ((await deps.store.read())[target.key] !== undefined) {
                    await deps.store.clear(target.key);
                    announce(target.provider, target.key, undefined);
                }
                return;
            }
            await readFailed(target, reading.failure ?? "the provider gave no reading");
        })()
            .catch(async (error: unknown) => {
                deps.logger.warn({ err: error, account: target.key }, "headroom: read failed, the next trigger retries");
                try {
                    await readFailed(target, "the read failed");
                } catch (markError) {
                    deps.logger.warn({ err: markError, account: target.key }, "headroom: could not mark the failed read on the snapshot");
                }
            })
            .finally(() => inFlight.delete(target.key));
        inFlight.set(target.key, read);
        return read;
    };

    const inScope = (target: HeadroomTarget, scope: RefreshScope | undefined): boolean =>
        (scope?.providers === undefined || scope.providers.includes(target.provider)) && (scope?.account === undefined || scope.account === target.key);

    const sweep = async (options: RefreshOptions): Promise<void> => {
        const maxAgeMs = options.maxAgeMs ?? FRESH_MS;
        const [targets, stored] = await Promise.all([
            // One source that cannot list its accounts must not starve the others; its numbers stop moving, so it says why.
            Promise.all(
                deps.sources.map((source) =>
                    source.targets().catch((error: unknown) => {
                        deps.logger.warn({ err: error }, "headroom: a source could not list its accounts, their readings stand still");
                        return [];
                    }),
                ),
            ).then((lists) => lists.flat()),
            deps.store.read(),
            seed(),
        ]);
        const now = Date.now();
        // A re-measure someone is watching asks for zero and gets it; every other trigger is held to the endpoint's own
        // budget however fresh it asked for, since a trigger that outruns it spends the account's allowance to read the
        // same number.
        const bound = (target: HeadroomTarget): number => (options.watched === true ? maxAgeMs : Math.max(maxAgeMs, target.minAgeMs ?? 0));
        const due = targets.filter(
            (target) =>
                inScope(target, options.scope) &&
                (blockedUntil.get(target.key)?.until ?? 0) <= now &&
                // `>=`, so a bound of zero reads it regardless of the clock, as the caller meant.
                now - Math.max(stored[target.key]?.measuredAt ?? 0, attemptedAt.get(target.key) ?? 0) >= bound(target),
        );
        const pending = [...due];
        const worker = async (): Promise<void> => {
            for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
                await readOne(next);
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
    };

    // Never rejects: an account list must not fail because a quota read did. Seeds before racing the caller's deadline,
    // so `held` is answerable the moment any refresh returns — including the first one after a restart, which is
    // exactly when a caller is owed the park this process did not earn itself.
    const refresh = async (options: RefreshOptions = {}): Promise<void> => {
        await seed();
        const pending = sweep(options).catch((error: unknown) => deps.logger.warn({ err: error }, "headroom: sweep failed, the next trigger retries"));
        return options.withinMs === undefined ? pending : Promise.race([pending, deadline(options.withinMs)]);
    };

    return {
        refresh,
        held: () => {
            const now = Date.now();
            return [...blockedUntil]
                .flatMap(([account, parked]) => (parked.until > now ? [{ provider: parked.provider, account, until: parked.until }] : []))
                .toSorted((left, right) => left.until - right.until);
        },
        parked: async (account) => {
            // Awaits the seed rather than the mirror alone: this is asked by a reader that may run before any sweep has.
            await seed();
            return (blockedUntil.get(account)?.until ?? 0) > Date.now();
        },
        park: (provider, account, forMs) => parkUntil(provider, account, Date.now() + forMs),
        record,
        clear: async (provider, account) => {
            attemptedAt.delete(account);
            failedReasons.delete(account);
            blockedUntil.delete(account);
            await Promise.all([deps.store.clear(account), deps.parks.clear(account)]);
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
