import type { ResourceNode } from "@intentic/graph";
import { hashInputs, ownershipOf, refKey } from "@intentic/graph";
import type { ResourceType } from "@intentic/resources";
import type { DiffResult, Observed, Provider, ProviderContext, Providers } from "../provider.js";
import type { OutputStore } from "../store.js";
import type { EngineConfig, ResolvedInputs } from "../types.js";

export const requireProvider = (providers: Providers, type: ResourceType, id: string): Provider => {
    const provider = providers[type];
    if (provider === undefined) {
        throw new Error(`no provider registered for type "${type}" (resource "${id}")`);
    }
    return provider;
};

// What every provider call of one run shares: the env secrets resolve from, the log, and the owner to stamp.
export interface RunScope {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly log: (message: string) => void;
    readonly owner?: string;
}

export const runScope = (config: EngineConfig): RunScope => ({
    env: config.env ?? process.env,
    log: config.log ?? console.log,
    ...(config.owner !== undefined ? { owner: config.owner } : {}),
});

export const makeContext = (id: string, store: OutputStore, scope: RunScope, inputsHash?: string): ProviderContext => ({
    env: scope.env,
    log: scope.log,
    id,
    output: (depId, name) => store.get(refKey(depId, name), { lenient: false }),
    ...(inputsHash !== undefined ? { inputsHash } : {}),
    ...(scope.owner !== undefined ? { owner: scope.owner } : {}),
});

// Stops a run before its next mutation once its signal is aborted (the CLI aborts it when the apply lock is lost).
export const checkSignal = (config: EngineConfig): void => {
    config.signal?.throwIfAborted();
};

// How often a still-running provider read narrates itself.
const READ_NARRATE_INTERVAL_MS = 15_000;

// Await a provider read, narrating every 15s while it runs, shared by plan and apply. A slow or hung read
// must name itself in the event stream: the narration feeds the UI's activity line, timestamps the stall in
// the persisted run log, and (because an interval only fires on a live event loop) proves in a postmortem
// whether a silent stretch was a pending promise or a blocked loop.
export const narratedRead = async (
    provider: Provider,
    inputs: ResolvedInputs,
    ctx: ProviderContext,
    id: string,
    log: (message: string) => void,
): Promise<Observed | undefined> => {
    const started = Date.now();
    const narrator = setInterval(() => log(`still reading ${id} (${Math.round((Date.now() - started) / 1000)}s)`), READ_NARRATE_INTERVAL_MS);
    narrator.unref();
    try {
        return await provider.read(inputs, ctx);
    } finally {
        clearInterval(narrator);
    }
};

// The ownership check on a live resource of the graph, for a provider that reads its owner stamp back: one this intent
// stamped is fine; an unowned one (stamped before owners existed) is adopted by an update that re-stamps it; one
// stamped by another intent is a conflict a person must settle, since applying would take it over.
export const ownerDrift = (id: string, observed: Observed, owner: string | undefined): DiffResult | undefined => {
    if (owner === undefined || observed.stampOwner === undefined) {
        return undefined;
    }
    const ownership = ownershipOf(observed.stampOwner, owner);
    if (ownership === "mine") {
        return undefined;
    }
    if (ownership === "unowned") {
        return { action: "update", reason: `adopting: stamp it as owned by intent ${owner}` };
    }
    throw new Error(
        `"${id}" is live but stamped as owned by intent "${observed.stampOwner}", not this one ("${owner}"): two intents declare the same resource on a shared host or zone. Rename it in one of them, or remove it there first.`,
    );
};

// The engine-level drift check, shared by plan and apply. Ownership first (above). Then a resource whose stamped
// inputs hash no longer matches the node's serialized inputs is an update regardless of what the provider's diff
// would say, authored config changed since the last stamped apply. Falls through to the provider's own diff (live
// drift: image pins etc.) when no hash is stamped or it matches.
export const decideDiff = (provider: Provider, node: ResourceNode, inputs: ResolvedInputs, observed: Observed, owner?: string): DiffResult =>
    ownerDrift(node.id, observed, owner) ??
    (observed.stampHash !== undefined && observed.stampHash !== hashInputs(node.inputs)
        ? { action: "update", reason: "authored inputs changed since last stamped apply" }
        : provider.diff(inputs, observed));
