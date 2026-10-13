import {
    type AgentProvider,
    capabilitiesOf,
    endpointProvider,
    loopsOf,
    NATIVE_PROVIDERS,
    pairHealthKey,
    TRIAL_ENDPOINT_ID,
} from "@intentic/sandbox-contract";
import { mintsEndpointProvider } from "../../endpoints/local-model.js";
import type { Services } from "../../composition.js";
import type { RuntimeDeps } from "../../runtimes/runtime-table.js";
import type { AdapterHealth } from "./adapter.js";

// Whether each runtime can serve a turn, probed on a timer and answered from cache (platform/version-check.ts's shape),
// so a slow probe never blocks a hot route. A cold cache reads as "unknown", treated as available-but-unverified
// (AdapterHealth.state). Lets the picker warn about a signed-out account before a turn is sent, not after it fails.

const REFRESH_MS = 5 * 60_000;

// Keyed by runtime, and by pairHealthKey(runtime, provider) for a pair whose runtime answers per provider.
export type RuntimeHealth = Readonly<Record<string, AdapterHealth>>;

// Cold until the first sweep lands; not pre-seeded with "unknown" entries, since undefined and all-unknown already mean
// the same thing to every reader.
let cached: RuntimeHealth | undefined;

export const runtimeHealth = (): RuntimeHealth | undefined => cached;

// Sweeps every adapter concurrently, since they touch different stores and a slow one must not delay the rest. Never
// throws: guards against a probe that throws outright, not just one that already answers "unknown".
// What the sweep hands each adapter's probe, and the table it walks.
type HealthDeps = RuntimeDeps & Pick<Services, "adapters" | "capabilities">;

// try/catch, not `.catch()`: a synchronous throw before the promise exists would have nothing to attach to and would
// escape into this timer.
const probed = async (probe: () => Promise<AdapterHealth>): Promise<AdapterHealth> => {
    try {
        return await probe();
    } catch {
        return { state: "unknown", checkedAt: Date.now() };
    }
};

// Every provider a loop could host: the native ones, and each endpoint the owner configured (the trial excluded, which
// runs on one loop only). A card list that can't be read leaves the endpoints to their runtimes' answers.
const hostedCandidates = async (services: Pick<Services, "capabilities">): Promise<readonly AgentProvider[]> => {
    // allow(silent-catch): an unreadable card list costs the endpoints their per-pair answer, not the sweep
    const cards = await services.capabilities.list().catch(() => []);
    const endpoints = cards.filter((card) => mintsEndpointProvider(card.kind) && card.id !== TRIAL_ENDPOINT_ID).map((card) => endpointProvider(card.id));
    return [...NATIVE_PROVIDERS, ...endpoints];
};

// Each (runtime, provider) pair whose runtime answers per provider (AgentAdapter.hostHealth), under its pair key.
const pairEntries = async (services: HealthDeps): Promise<(readonly [string, AdapterHealth])[]> => {
    const byRuntime = new Map(services.adapters.all.map((adapter) => [adapter.runtime, adapter] as const));
    const pairs = (await hostedCandidates(services)).flatMap((provider) =>
        loopsOf(provider).flatMap((loop) => {
            const runtime = capabilitiesOf(provider, loop).runtime;
            const host = byRuntime.get(runtime)?.hostHealth;
            return host === undefined ? [] : [{ key: pairHealthKey(runtime, provider), probe: () => host(services, provider) }];
        }),
    );
    return Promise.all(pairs.map(async ({ key, probe }) => [key, await probed(probe)] as const));
};

const refreshRuntimeHealth = async (services: HealthDeps): Promise<void> => {
    const [entries, pairs] = await Promise.all([
        Promise.all(services.adapters.all.map(async (adapter) => [adapter.runtime, await probed(() => adapter.health(services))] as const)),
        pairEntries(services),
    ]);
    cached = Object.fromEntries([...entries, ...pairs]) as RuntimeHealth;
};

// Boot-time sweep (bootstrap/boot-schedulers.ts): warms the cache immediately, then on an interval. Unref'd so it never holds the event loop
// open; tests that build the app directly never call this. Returns the stop, for the daemon's shutdown.
export const startRuntimeHealth = (services: HealthDeps): (() => void) => {
    const tick = (): void => {
        void refreshRuntimeHealth(services);
    };
    tick();
    const timer = setInterval(tick, REFRESH_MS).unref();
    return () => clearInterval(timer);
};
