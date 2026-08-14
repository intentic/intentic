import type { AgentCapabilities } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import type { AdapterHealth } from "./adapter.js";
import { ADAPTERS } from "./adapter-registry.js";

/* CAN EACH RUNTIME SERVE A TURN — asked on a timer, answered from cache.
 *
 * The shape is platform/version-check.ts's, and for the same reason it gives: a probe reads a credential store
 * and may reach the translator, so putting it on a request path couples a hot route to whatever the network is
 * doing. The cache is read synchronously by /info; a cold cache answers "unknown", which every surface treats
 * as available-but-unverified rather than greying a provider out (see AdapterHealth.state).
 *
 * WHY IT IS WORTH HAVING AT ALL. Before this, a signed-out account or an absent subscription was discoverable
 * in exactly one way: write a prompt, pick a model, send, and read the failure. The refusal was always good —
 * planCodexTurn has said "Connect your ChatGPT subscription" for months — it just arrived after the user had
 * committed to a turn. The probes here ask the same question with nothing at stake, so the picker can say it
 * first. That is the whole feature; nothing here changes what a turn does. */

const REFRESH_MS = 5 * 60_000;

export type RuntimeHealth = Readonly<Record<AgentCapabilities["runtime"], AdapterHealth>>;

// Cold until the first sweep lands. Not seeded with "unknown" entries — an absent map and a map of unknowns
// mean the same thing to every reader, and one of them cannot go stale.
let cached: RuntimeHealth | undefined;

export const runtimeHealth = (): RuntimeHealth | undefined => cached;

/* One sweep across every adapter, concurrently — they touch different stores, and a slow account listing must
 * not delay the answer for the three runtimes that do not need it.
 *
 * Never throws. An adapter's own probe already answers "unknown" for a failure it can see; this guards the
 * ones it cannot (a probe that throws outright), because a background timer that can reject is a daemon that
 * logs an unhandled rejection every five minutes. */
const refreshRuntimeHealth = async (services: Services): Promise<void> => {
    const entries = await Promise.all(
        ADAPTERS.map(async (adapter) => {
            // try/catch, not `.catch()`: an adapter that threw before returning a promise would have nothing to
            // attach to and the throw would escape into this background timer — see adapter-registry's attempt.
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

// Boot-time background sweep (main.ts): warm the cache now, then on an interval. Unref'd so it never holds the
// event loop open, and started only at boot — tests that build the app directly never probe.
export const startRuntimeHealth = (services: Services): void => {
    const tick = (): void => {
        void refreshRuntimeHealth(services);
    };
    tick();
    setInterval(tick, REFRESH_MS).unref();
};
