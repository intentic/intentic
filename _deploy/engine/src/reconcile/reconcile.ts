import type { ResourceNode } from "@intentic/graph";
import { hashInputs, refKey } from "@intentic/graph";
import type { ResourceType } from "@intentic/resources";
import type { DiffResult, Observed, Provider, ProviderContext, Providers } from "../provider.js";
import type { OutputStore } from "../store.js";
import type { ResolvedInputs } from "../types.js";

export const requireProvider = (providers: Providers, type: ResourceType, id: string): Provider => {
    const provider = providers[type];
    if (provider === undefined) {
        throw new Error(`no provider registered for type "${type}" (resource "${id}")`);
    }
    return provider;
};

export const makeContext = (
    id: string,
    store: OutputStore,
    env: Readonly<Record<string, string | undefined>>,
    log: (message: string) => void,
    inputsHash?: string,
): ProviderContext => ({
    env,
    log,
    id,
    output: (depId, name) => store.get(refKey(depId, name), { lenient: false }),
    ...(inputsHash !== undefined ? { inputsHash } : {}),
});

// How often a still-running provider read narrates itself.
const READ_NARRATE_INTERVAL_MS = 15_000;

// Await a provider read, narrating every 15s while it runs — shared by plan and apply. A slow or hung read
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

// The engine-level drift check, shared by plan and apply: a resource whose stamped inputs hash no longer
// matches the node's serialized inputs is an update regardless of what the provider's diff would say —
// authored config changed since the last stamped apply. Falls through to the provider's own diff (live
// drift: image pins etc.) when no hash is stamped or it matches.
export const decideDiff = (provider: Provider, node: ResourceNode, inputs: ResolvedInputs, observed: Observed): DiffResult =>
    observed.stampHash !== undefined && observed.stampHash !== hashInputs(node.inputs)
        ? { action: "update", reason: "authored inputs changed since last stamped apply" }
        : provider.diff(inputs, observed);
