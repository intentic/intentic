import type { AgentCapabilities } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { AdapterHealth } from "./adapter.js";
import { allAdapters } from "./adapter-registry.js";

// Whether each runtime can serve a turn, probed on a timer and answered from cache (platform/version-check.ts's shape),
// so a slow probe never blocks a hot route. A cold cache reads as "unknown", treated as available-but-unverified
// (AdapterHealth.state). Lets the picker warn about a signed-out account before a turn is sent, not after it fails.

const REFRESH_MS = 5 * 60_000;

export type RuntimeHealth = Readonly<Record<AgentCapabilities["runtime"], AdapterHealth>>;

// Cold until the first sweep lands; not pre-seeded with "unknown" entries, since undefined and all-unknown already mean
// the same thing to every reader.
let cached: RuntimeHealth | undefined;

export const runtimeHealth = (): RuntimeHealth | undefined => cached;

// Sweeps every adapter concurrently, since they touch different stores and a slow one must not delay the rest. Never
// throws: guards against a probe that throws outright, not just one that already answers "unknown".
const refreshRuntimeHealth = async (services: Services): Promise<void> => {
    const entries = await Promise.all(
        allAdapters().map(async (adapter) => {
            // try/catch, not `.catch()`: a synchronous throw before the promise exists would have nothing to attach to
            // and would escape into this timer.
            let health: AdapterHealth;
            try {
                health = await adapter.health(services);
            } catch {
                health = { state: "unknown", checkedAt: Date.now() };
            }
            return [adapter.runtime, health] as const;
        }),
    );
    cached = Object.fromEntries(entries) as RuntimeHealth;
};

// Boot-time sweep (main.ts): warms the cache immediately, then on an interval. Unref'd so it never holds the event loop
// open; tests that build the app directly never call this.
export const startRuntimeHealth = (services: Services): void => {
    const tick = (): void => {
        void refreshRuntimeHealth(services);
    };
    tick();
    setInterval(tick, REFRESH_MS).unref();
};
