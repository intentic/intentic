import type { QueryClient } from "@tanstack/vue-query";
import { reportClient } from "./clientDiagnostics";

// A read still pending long past any budget a daemon call has (perf.ts gives one 1.5 s before calling it slow). A view
// whose read never settles draws its skeleton forever, and nothing else anywhere records it: a slow span is filed only
// when the call ends, and this one has not.
export const STALLED_MS = 30_000;
const CHECK_EVERY_MS = 10_000;

/** Reports each fetch that stays pending past STALLED_MS, once per fetch. Answers the function that stops watching. */
export const watchStalledQueries = (client: QueryClient, now: () => number = Date.now): (() => void) => {
    const cache = client.getQueryCache();
    // When each query's current fetch began, by its hash; and which of those are already reported.
    const started = new Map<string, number>();
    const reported = new Set<string>();

    const unsubscribe = cache.subscribe((event) => {
        if (event.type === `removed`) {
            started.delete(event.query.queryHash);
            reported.delete(event.query.queryHash);
            return;
        }
        if (event.type === `updated` && event.action.type === `fetch` && !started.has(event.query.queryHash)) {
            started.set(event.query.queryHash, now());
        }
    });

    const check = (): void => {
        try {
            const at = now();
            for (const query of cache.getAll()) {
                const hash = query.queryHash;
                // Paused (offline) is waiting for the network on purpose, not stalled.
                if (query.state.fetchStatus !== `fetching`) {
                    started.delete(hash);
                    reported.delete(hash);
                    continue;
                }
                const since = started.get(hash);
                if (since === undefined) {
                    // A fetch begun before the watch: timed from first sight, which only ever reports it later.
                    started.set(hash, at);
                    continue;
                }
                if (at - since < STALLED_MS || reported.has(hash)) {
                    continue;
                }
                reported.add(hash);
                const key = JSON.stringify(query.queryKey).slice(0, 300);
                reportClient(`query.stalled`, `query ${key} still pending after ${Math.round((at - since) / 1_000)}s`, {
                    level: `warn`,
                    fields: {
                        key,
                        pendingMs: at - since,
                        // Retries under way say the read is failing over and over rather than waiting on one answer.
                        failures: query.state.fetchFailureCount,
                        hasData: query.state.data !== undefined,
                        observers: query.getObserversCount(),
                        hidden: document.visibilityState === `hidden`,
                    },
                });
            }
            // allow(silent-catch): watching must never be the thing that fails; a missed stall report is the only cost
        } catch {
            // Nothing to do: the next check runs regardless.
        }
    };

    const timer = setInterval(check, CHECK_EVERY_MS);
    return () => {
        clearInterval(timer);
        unsubscribe();
    };
};
