import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { CapacityAccount, CapacitySnapshot, ProviderCapacity, ProviderDegraded } from "@intentic/sandbox-contract/schemas/providers/capacity";
import { capacityValidUntil, factsAt, flappingAccounts, type ServiceFacts, serviceStates } from "@intentic/sandbox-contract/models/plan-pools";
import { NATIVE_PROVIDERS, TRANSLATOR_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import { opt } from "../../opt.js";
import { accountFactsOf, type ServiceabilityDeps } from "./serviceability.js";

/* EACH PROVIDER'S CAPACITY, JUDGED WHOLE BY THE DAEMON AND SENT AS ONE MESSAGE (schemas/providers/capacity.ts): every
   fact the serviceability rule reads, each reading as it stands at the instant judged, the verdict with no model named,
   where an unnamed turn would run, whether the provider itself is failing, and the next instant the clock alone changes
   any of it. capacity-watch.ts judges a provider again on every change under it and at that instant, and sends the result
   to every window that asked (`/events` `capacity`); `usage.capacity` answers the whole picture on request.

   Two halves of the picture live above this layer, so they come in as ports: where an unnamed turn would run (the agent
   layer's one placement, which counts what already runs on each account) and whether the provider is failing turns (the
   agent layer's outage breaker). Without them the picture leaves those out rather than guessing. */

/** What narrows a placement to the turn one asker would send: its loop, and the accounts that asker may run on. */
export interface PlacementNarrowing {
    readonly loop?: string | undefined;
    readonly allows?: ((account: string) => boolean) | undefined;
}

export interface CapacityPorts {
    // The account a turn naming no account (and the given model, or none) would run on now; narrowed where asked.
    readonly placementOf?: ((provider: AgentProvider, model: string | undefined, narrow?: PlacementNarrowing) => Promise<string | undefined>) | undefined;
    // Whether the provider itself is failing or throttling turns right now.
    readonly degradedOf?: ((provider: AgentProvider) => ProviderDegraded | undefined) | undefined;
}

export type CapacityFeedDeps = ServiceabilityDeps;

// The ports the agent layer fills at boot (bootstrap/boot-schedulers.ts), what every caller reads unless it hands its own
// (a test): kept apart from the services, which are a bag of stores and never answer for a member they do not hold.
let provided: CapacityPorts = {};

/** Fills the ports for this process; answers the undo, for a test. */
export const provideCapacityPorts = (ports: CapacityPorts): (() => void) => {
    provided = ports;
    return () => {
        if (provided === ports) {
            provided = {};
        }
    };
};

/** Where a turn naming no account would run on `provider` and `model`, by the agent layer's one placement. */
export const placementOf = (
    provider: AgentProvider,
    model: string | undefined,
    narrow: PlacementNarrowing = {},
    ports: CapacityPorts = provided,
): Promise<string | undefined> => ports.placementOf?.(provider, model, narrow) ?? Promise.resolve(undefined);

// Rises with every capacity judged, across providers, for the life of this process: a window holding two for one provider
// keeps the higher.
let sequence = 0;

const accountOf = (facts: ServiceFacts, state: CapacityAccount["state"], flapping: boolean): CapacityAccount => ({
    account: facts.account,
    ...opt("label", facts.label),
    ...opt("needsReauth", facts.needsReauth),
    ...opt("detail", facts.detail),
    ...opt("seatRefusal", facts.seatRefusal),
    ...opt("cooling", facts.cooling),
    ...opt("cooldowns", facts.cooldowns === undefined ? undefined : [...facts.cooldowns]),
    ...opt("usage", facts.usage),
    ...opt("models", facts.models === undefined ? undefined : [...facts.models]),
    state,
    ...opt("flapping", flapping ? (true as const) : undefined),
});

const placementOr = (ports: CapacityPorts, provider: AgentProvider): Promise<string | undefined> =>
    // allow(silent-catch): the placement is advice beside the verdicts; a picture without it still says what can serve.
    ports.placementOf?.(provider, undefined).catch(() => undefined) ?? Promise.resolve(undefined);

/** One provider's capacity judged at `now`, the sandbox's clock. */
export const providerCapacity = async (
    deps: CapacityFeedDeps,
    provider: AgentProvider,
    now: number = Date.now(),
    ports: CapacityPorts = provided,
): Promise<ProviderCapacity> => {
    const [facts, onFile, switchOffs, placement] = await Promise.all([
        accountFactsOf(deps, provider),
        deps.providerRefusals.onFile(),
        deps.providerRefusals.switchOffs(provider),
        placementOr(ports, provider),
    ]);
    const refusals = onFile[provider] ?? [];
    const current = facts.map((entry) => factsAt(entry, now));
    const states = serviceStates(current, refusals, undefined, now);
    const flapping = flappingAccounts(switchOffs, now);
    const degraded = ports.degradedOf?.(provider);
    const clock = capacityValidUntil(current, states, refusals, switchOffs, now);
    const retry = degraded !== undefined && degraded.retryAt > now ? degraded.retryAt : undefined;
    const validUntil = clock === undefined ? retry : retry === undefined ? clock : Math.min(clock, retry);
    sequence += 1;
    return {
        provider,
        seq: sequence,
        judgedAt: now,
        ...opt("validUntil", validUntil),
        accounts: current.map((entry) => accountOf(entry, states.get(entry.account) ?? { kind: "unknown" }, flapping.has(entry.account))),
        refusals: [...refusals],
        ...opt("switchOffs", Object.keys(switchOffs).length === 0 ? undefined : switchOffs),
        ...opt("placement", current.length < 2 ? undefined : placement),
        ...opt("degraded", degraded),
    };
};

/** Every provider with an account connected or a refusal on file, judged at `now`. */
export const capacitySnapshot = async (deps: CapacityFeedDeps, now: number = Date.now(), ports: CapacityPorts = provided): Promise<CapacitySnapshot> => {
    const onFile = await deps.providerRefusals.onFile();
    const providers = [...new Set<string>([...NATIVE_PROVIDERS, ...TRANSLATOR_PROVIDERS, ...Object.keys(onFile)])];
    const judged = await Promise.all(providers.map((provider) => providerCapacity(deps, provider, now, ports)));
    return { providers: judged.filter((capacity) => capacity.accounts.length > 0 || capacity.refusals.length > 0 || capacity.degraded !== undefined) };
};

const listeners = new Set<(capacity: ProviderCapacity) => void>();

/** Hears every provider's capacity as it is judged again; answers its own unsubscribe. */
export const onCapacity = (listener: (capacity: ProviderCapacity) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** Whether anyone is listening, so a judgement nobody would hear is not assembled. */
export const capacityHeard = (): boolean => listeners.size > 0;

/** Sends a provider's capacity to everyone listening. */
export const announceCapacity = (capacity: ProviderCapacity): void => {
    for (const listener of listeners) {
        listener(capacity);
    }
};
