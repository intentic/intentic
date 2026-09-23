import {
    type AgentProvider,
    endpointIdOf,
    isTrialProvider,
    NATIVE_PROVIDERS,
    type NativeProvider,
    type RunnableProviders,
} from "@intentic/sandbox-contract";
import { sandboxScopeGuard, sandboxValue } from "@intentic/extension-api";
import { watch } from "vue";
import { z } from "zod";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import {
    acpProviders,
    endpointProviders,
    nativeReady,
    endpointsLoaded,
    providerCommands,
    providerDefaultModel,
    providerModels,
    providerModelsState,
    trialStatus,
} from "../accounts/providerCatalog";
import { active, conversations } from "../tabs/useChat-tabs";
import { withConcurrency } from "../../../lib/concurrency";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import { type ProcedureOutput, sandboxRpc } from "../../sandbox/client/sandboxRpc";

// A read whose failure is not news: apply what the daemon sent, and on any failure leave the ref holding its last
// value. An answer from a sandbox the scope has since left is dropped the same way: it is not this one's record.
export const readOrKeep = async <T>(read: Promise<T>, apply: (body: T) => void): Promise<void> => {
    const current = sandboxScopeGuard();
    try {
        const body = await read;
        if (current()) {
            apply(body);
        }
    } catch {
    }
};

// Loads a provider's daemon-published slash commands into the shared record; cheap (daemon caches it in memory),
// so it rides the same seam as account/model catalogs.
export const loadProviderCommands = (target: AgentProvider): Promise<void> =>
    readOrKeep(sandboxRpc.agent.commands({ agent: target }), (body) => {
        providerCommands.value = { ...providerCommands.value, [target]: body.commands };
    });

// Retries per provider because the daemon learns its commands from that provider's first turn, not upfront; a page
// load before any turn cached an empty list otherwise. Repeated only while empty; concurrent askers share one
// promise, within one sandbox: the next one opens its own.
const commandsInFlight = sandboxValue(() => new Map<AgentProvider, Promise<void>>());

export const ensureProviderCommands = (target: AgentProvider): Promise<void> => {
    if ((providerCommands.value[target] ?? []).length > 0) {
        return Promise.resolve();
    }
    const already = commandsInFlight.value.get(target);
    if (already !== undefined) {
        return already;
    }
    const reads = commandsInFlight.value;
    const reading = loadProviderCommands(target).finally(() => reads.delete(target));
    reads.set(target, reading);
    return reading;
};

// Two shapes: a native provider is a fixed daemon-known id (shared route); an endpoint is a user-created capability
// whose id names its own route. Any other provider (an ACP agent) has no catalog, which the daemon says by refusing it.
const readModels = (p: AgentProvider): Promise<ProcedureOutput<`providers.models`>> => {
    const endpointId = endpointIdOf(p);
    return endpointId !== undefined
        ? sandboxRpc.endpoints.models({ id: endpointId })
        : sandboxRpc.providers.models({ provider: p as NativeProvider });
};

// Loads a provider's catalog, then repoints any selection (conversation or persisted default) no longer offered to
// the live default. Claude-Code-harness ids are translator-mapped, not catalog ids, and stay untouched.
const loadProviderModelsOnce = async (target: AgentProvider): Promise<void> => {
    providerModelsState.value = { ...providerModelsState.value, [target]: `loading` };
    // A catalog asked of the sandbox the scope has since left says nothing about this one's models.
    const current = sandboxScopeGuard();
    let body: ProcedureOutput<`providers.models`>;
    try {
        body = await readModels(target);
    } catch {
        // Refused, unreadable, or the daemon is unreachable/mid-restart; the picker shows the error row with a Retry.
        if (current()) {
            providerModelsState.value = { ...providerModelsState.value, [target]: `error` };
        }
        return;
    }
    if (!current()) {
        return;
    }
    providerModelsState.value = { ...providerModelsState.value, [target]: `loaded` };
    // The daemon's catalog is never empty; this guard stops a selection from ever being pinned to nothing.
    if (body.models.length === 0) {
        return;
    }
    providerModels.value = {
        ...providerModels.value,
        [target]: body.models.map((entry) => ({
            label: entry.label,
            value: entry.id,
            ...(entry.efforts !== undefined ? { efforts: entry.efforts } : {}),
            ...(entry.description !== undefined ? { description: entry.description } : {}),
            ...(entry.badges !== undefined ? { badges: entry.badges } : {}),
            ...(entry.availableAt !== undefined ? { availableAt: entry.availableAt } : {}),
        })),
    };
    providerDefaultModel.value = { ...providerDefaultModel.value, [target]: body.default };
    // Moves an open chat off a model this catalog no longer offers (renamed, retired, or a rung the provider has
    // stopped serving) and back onto it when the next read lists it again. Reversible because the two cases are
    // indistinguishable from here: a routed channel de-lists a model for as long as it is out of capacity for it, and
    // a one-way repoint spends the rest of the conversation on a model the user never chose.
    const valid = new Set(body.models.map((entry) => entry.id));
    for (const conversation of conversations.value) {
        if (conversation.selection.provider.value !== target) {
            continue;
        }
        const displaced = conversation.selection.displacedModel.value;
        // Asked before the repoint, so a catalog that lists the owed pick again hands it back rather than moving the
        // chat a second time when the row it was parked on is the one that went.
        if (displaced !== undefined && valid.has(displaced)) {
            conversation.selection.apply({ kind: `restoreModel` });
            continue;
        }
        if (!valid.has(conversation.selection.model.value)) {
            conversation.selection.apply({ kind: `displaceModel`, model: body.default });
        }
    }
    // The remembered pick (not the open chat's model, moved above) is never rewritten from a catalog: a thin catalog
    // read must not spend a standing preference for good. rememberedModelFor re-resolves it against the live list.
};

// Deduped per-provider via singleFlight, not by reading `providerModelsState` back as a mutex: that ref is
// presentation state (spinner/error row), and using it to gate a request let concurrent calls duplicate a fetch. One
// flight table per sandbox, so a load after a switch never joins a read the outgoing daemon is answering.
const modelLoads = sandboxValue(() => withConcurrency(loadProviderModelsOnce, { mode: `singleFlight`, key: (target) => target }));
export const loadProviderModels = (target: AgentProvider): Promise<void> => modelLoads.value(target);

// Refreshes every native provider's catalog so cross-provider search has all lists warm; ACP providers have no
// daemon catalog. Safe to spam: in-flight providers collapse into their running load.
export const loadAllProviderModels = async (): Promise<void> => {
    await Promise.all(NATIVE_PROVIDERS.map((target) => loadProviderModels(target)));
};

// The one catalog a first paint reads: the open chat's own, for the model its composer names. Every other provider's
// list is fetched when something puts a chat on it (selectProvider, selectModel, a settled connect, a rejected model)
// or when the picker opens and refreshes the lot, so warming the whole native list on the reachable seam spent a
// request per provider on lists nothing was showing — against a daemon that has the first screen's reads queued
// behind them.
export const loadActiveProviderModels = (): Promise<void> => loadProviderModels(active.value.selection.provider.value);

// Reads the free trial's remaining allowance, separate from the capability read that discovers the trial exists
// (different clocks). A failure keeps the previous figures rather than zeroing them.
export const loadTrialStatus = (): Promise<void> =>
    // Left as-is on a failure; the next reachable load asks again.
    readOrKeep(sandboxRpc.endpoints.trial(), (status) => {
        trialStatus.value = status;
    });

// Re-reads the allowance once a turn settles, only for isTrialProvider: every other provider's count isn't this
// meter's business, and polling after those turns would return the same number.
watch(
    () => active.value.turn.streaming.value,
    (isStreaming, was) => {
        if (was === true && !isStreaming && isTrialProvider(active.value.selection.provider.value)) {
            void loadTrialStatus();
        }
    },
);

// The providers this sandbox adds to the fixed native list: ACP agents (the row is the provider itself) and model
// endpoints (their own catalog, loaded right after). Read from `providers.list`, not `capabilities.list`: which
// providers a chat may run on is every member's read, while what this box connects to is the operator's alone.
// The readiness half: which providers can run. Answers the endpoints whose catalogs the endpoint half loads, or
// undefined when a daemon that may yet answer leaves both halves unknown.
const readRunnableProviders = async (): Promise<RunnableProviders["endpoints"] | undefined> => {
    const current = sandboxScopeGuard();
    let listing: RunnableProviders;
    try {
        listing = await sandboxRpc.providers.list();
    } catch (error) {
        // Only a read that may yet succeed is worth waiting on. 403 (this member's tier doesn't reach it), 404 (a daemon
        // that doesn't serve it) and a body this build can't read (the client's parse refused it) answer the same way
        // every time, so they leave the half known and empty rather than holding a spinner over every gated surface for
        // as long as the tab is open. A 5xx or an unreachable daemon leaves it unknown, and the next reachable seam asks
        // again.
        const settled = (error instanceof SandboxHttpError && (error.status === 403 || error.status === 404)) || error instanceof z.core.$ZodError;
        return settled ? [] : undefined;
    }
    // The outgoing sandbox's list: this one's readiness is unknown still, and its own read will say.
    if (!current()) {
        return undefined;
    }
    nativeReady.value = listing.native;
    acpProviders.value = listing.agents;
    // Ids arrive already prefixed `endpoint/`, and `kind` rides along: it's the only way to tell a local model from a
    // remote server once both are `endpoint/<id>`.
    endpointProviders.value = listing.endpoints;
    return listing.endpoints;
};

// The endpoint half: each endpoint's catalog, on the same seam as native ones (not loadAllProviderModels, a fixed
// list), then the trial allowance. Read last: catalogs must land first, or a chat moved onto the trial keeps an empty
// model id forever.
const loadEndpointHalf = async (endpoints: RunnableProviders["endpoints"]): Promise<void> => {
    const current = sandboxScopeGuard();
    await Promise.all(endpoints.map((endpoint) => loadProviderModels(endpoint.id)));
    await loadTrialStatus();
    if (current()) {
        endpointsLoaded.value = true;
    }
};

// Two halves with different waiters: `ready` once the readiness half has landed, which is all the account gate needs;
// `settled` once the endpoint half has too, which only `endpointsLoaded` waits on.
export const loadRunnableProviders = (): { readonly ready: Promise<void>; readonly settled: Promise<void> } => {
    const endpoints = readRunnableProviders();
    return {
        ready: endpoints.then(() => undefined),
        settled: endpoints.then((found) => (found === undefined ? undefined : loadEndpointHalf(found))),
    };
};

// Singleton per window (hotReload.ts): a hot-reload re-run would mint a second set of in-flight catalog reads.
reloadOnHotUpdate(import.meta);
