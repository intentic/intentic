import type { AccountUsage, AgentProvider, UsageWindow } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { AccountUsageStore } from "./account-usage.js";

/* KEEPING EVERY ACCOUNT'S HEADROOM CURRENT, one service for every provider, and the one place a reading is
 * asked for, coalesced, backed off and announced.
 *
 * This used to be two copies of the same loop: a Claude refresher with a freshness bound, a stay-away map and
 * a queued forced sweep, and a translator client with an attempt map, a concurrency bound and a stale-check
 * fired from its own account list, each on its own five-minute timer that ran whether or not anything had
 * changed or anyone was looking. Between them they read thirty-odd upstream endpoints every five minutes to
 * refresh numbers nobody was reading, and still had no reading at the moments a number actually decides
 * something: the routed rings were up to five minutes old right after the turn that changed them, and a
 * refusal, the strongest live signal a plan gives, recorded itself and re-measured nothing.
 *
 * So the readings are taken WHEN SOMETHING HAPPENED rather than on a clock: a turn settled, a plan refused, a
 * screen opened, a person pressed re-measure, a proxy came up. Every trigger comes through `refresh` with a
 * scope (which provider, which account) and a freshness it will accept, so a screen that opens twice in a
 * minute costs one round-trip and a refusal re-reads the account that refused and nothing else. One long idle
 * floor remains (`start`), for the sandbox where nothing has happened for a quarter of an hour: an unattended
 * turn about to pick an account still wants a reading younger than the morning.
 *
 * WHAT A SOURCE IS. A provider contributes targets, one per account it can read, each knowing its own store
 * key and how to take its reading (usage/claude-usage.ts reads Anthropic's OAuth usage endpoint on the
 * account's own token; agent/translator.ts reads ChatGPT's, Google's and Kimi's through CLIProxyAPI's
 * credential-scoped call). Nothing here knows a provider's payload; it knows when to ask and what to do with
 * an answer, which is the half the two copies had duplicated.
 *
 * ANNOUNCED ON WRITE. Every reading that lands, from a sweep, a turn's own stream or a provider's push, goes
 * out to `onChange`, which the /events stream forwards to every connected browser (system.routes.ts). That is
 * what lets the rings stop refetching on mount and still agree across windows. */

export interface HeadroomReading {
    readonly windows: readonly UsageWindow[];
    // The endpoint's own stay-away on a 429, in ms. The one failure that must not be retried on the next
    // trigger: inside this window every read is a guaranteed 429 that keeps the window alive.
    readonly retryAfterMs?: number;
}

export interface HeadroomTarget {
    // The account's key in the shared store: a Claude account id, or `${provider}:${authFile}` for a routed one.
    readonly key: string;
    readonly provider: AgentProvider;
    // Take the reading. Never throws for an ordinary failure; an empty window list is "could not read" and
    // leaves the last good snapshot standing.
    readonly read: () => Promise<HeadroomReading>;
}

export interface HeadroomSource {
    readonly targets: () => Promise<readonly HeadroomTarget[]>;
}

export interface RefreshScope {
    // Only these providers' targets. Absent ⇒ every provider.
    readonly providers?: readonly AgentProvider[];
    // Only this account (its store key). Absent ⇒ every account in scope.
    readonly account?: string;
}

export interface RefreshOptions {
    readonly scope?: RefreshScope;
    /* How old a reading may be before it is worth another round-trip. Pools move with spend, not with the
     * clock, so a reading from the last minute is what the provider would answer again; the default is right
     * for a screen opening. A turn that just settled or a plan that just refused wants 0: something DID happen. */
    readonly maxAgeMs?: number;
    // Resolve after this long even if the reads have not landed: a page waiting on a list must get the rows
    // it has, and the readings it started still land for the next read. Absent ⇒ wait for the sweep.
    readonly withinMs?: number;
}

export interface HeadroomService {
    readonly refresh: (options?: RefreshOptions) => Promise<void>;
    // A reading obtained elsewhere (a turn's own stream, a provider's push), recorded and announced exactly as
    // a swept one is. The provider rides along because the announcement carries it: the store's key alone (a
    // bare Claude id, a `${provider}:${file}` for a routed one) does not say which provider's row it belongs to,
    // and the browser files every reading under the provider whose row draws it.
    readonly record: (provider: AgentProvider, account: string, usage: AccountUsage) => Promise<void>;
    readonly clear: (provider: AgentProvider, account: string) => Promise<void>;
    readonly read: AccountUsageStore["read"];
    // Every write, with the account's new snapshot, or undefined when it was cleared.
    readonly onChange: (listener: (provider: AgentProvider, account: string, usage: AccountUsage | undefined) => void) => () => void;
    // The idle floor: one sweep now, then one whenever a reading has gone `idleMs` without a trigger.
    readonly start: (idleMs?: number) => () => void;
}

// Under this, a reading is current enough that another round-trip would tell us nothing new.
export const FRESH_MS = 60_000;
// The idle floor. Long, because everything that changes a reading now triggers its own read; this covers the
// sandbox where nothing has happened and an unattended pick is about to read the file.
const IDLE_MS = 15 * 60_000;
// A sandbox can hold dozens of Google accounts, and firing every request at once is how a refresh becomes a
// self-inflicted rate limit.
const CONCURRENCY = 4;

const deadline = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        // Unref'd: a caller that stopped waiting must not hold the process open until its deadline.
        setTimeout(resolve, ms).unref();
    });

export const createHeadroomService = (deps: {
    readonly store: AccountUsageStore;
    readonly sources: readonly HeadroomSource[];
    readonly logger: Logger;
}): HeadroomService => {
    /* When each target was last ASKED, not what it answered. The store caches the successes; this is what bounds
     * the failures, an upstream that is down or a plan that publishes nothing would otherwise be retried on
     * every trigger. */
    const attemptedAt = new Map<string, number>();
    // The endpoint's stay-away, per target. Honoured by every trigger, forced ones included: inside it the
    // endpoint has already said what it will answer.
    const blockedUntil = new Map<string, number>();
    // The read in flight per target, so two triggers landing together cost one round-trip and both wait on it.
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
            // A read that failed or found no pool at all leaves the last good snapshot standing: an empty window
            // list would read as "measured, and this account has no limits", the opposite of what happened.
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
                // `>=`, so a bound of zero means what the caller meant: read it, whatever the clock says.
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

    // Never rejects: an account list must not fail because a quota read did, the rings are an enhancement to it.
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
            // The daemon's other loops do the same: a background refresh must never hold the process open.
            timer.unref();
            void refresh();
            return () => clearInterval(timer);
        },
    };
};
