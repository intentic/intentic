import {
    type AgentCommand,
    type AgentProvider,
    endpointIdOf,
    endpointProvider,
    isTrialProvider,
    type Model,
    NATIVE_PROVIDERS,
    TRIAL_LABEL,
    type TrialStatusResponse,
} from "@intentic/sandbox-contract";
import { watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import {
    acpProviders,
    endpointProviders,
    endpointsLoaded,
    providerCommands,
    providerDefaultModel,
    providerModels,
    providerModelsState,
    trialStatus,
} from "../accounts/providerCatalog";
import { active, conversations } from "../tabs/useChat-tabs";
import { withConcurrency } from "../../../lib/concurrency";
import { sandboxJson, sandboxRequest } from "../../sandbox/client/sandboxClient";

// A read whose failure is not news: apply what the daemon sent, and on any failure leave the ref holding its last
// value. Each caller is an annotation on a panel with its own reason to render; connection state is reported
// elsewhere.
export const readOrKeep = async <T>(path: string, apply: (body: T) => void): Promise<void> => {
    try {
        apply(await sandboxJson<T>(path));
    } catch {
    }
};

// Bumped by resetChat, so a read still in flight for the old sandbox cannot write into the new one's record.
let commandsEpoch = 0;

// Loads a provider's daemon-published slash commands into the shared record; cheap (daemon caches it in memory),
// so it rides the same seam as account/model catalogs.
export const loadProviderCommands = (target: AgentProvider): Promise<void> => {
    const epoch = commandsEpoch;
    return readOrKeep<{ commands: AgentCommand[] }>(`/agent/commands?agent=${encodeURIComponent(target)}`, (body) => {
        if (epoch === commandsEpoch) {
            providerCommands.value = { ...providerCommands.value, [target]: body.commands };
        }
    });
};

// Retries per provider because the daemon learns its commands from that provider's first turn, not upfront; a page
// load before any turn cached an empty list otherwise. Repeated only while empty; concurrent askers share one
// promise.
const commandsInFlight = new Map<AgentProvider, Promise<void>>();

export const ensureProviderCommands = (target: AgentProvider): Promise<void> => {
    if ((providerCommands.value[target] ?? []).length > 0) {
        return Promise.resolve();
    }
    const already = commandsInFlight.get(target);
    if (already !== undefined) {
        return already;
    }
    const reading = loadProviderCommands(target).finally(() => commandsInFlight.delete(target));
    commandsInFlight.set(target, reading);
    return reading;
};

// The reads in flight were asked of the outgoing daemon (resetChat): retire the epoch so their answers are
// dropped, and clear the handles so the incoming sandbox opens its own.
export const retireCommandReads = (): void => {
    commandsEpoch += 1;
    commandsInFlight.clear();
};

// Two shapes: a native provider is a fixed daemon-known id (shared route); an endpoint is a user-created capability
// whose id names its own route.
const modelsPath = (p: AgentProvider): string => {
    const endpointId = endpointIdOf(p);
    return endpointId !== undefined ? `/endpoints/${encodeURIComponent(endpointId)}/models` : `/providers/${encodeURIComponent(p)}/models`;
};

// Loads a provider's catalog, then repoints any selection (conversation or persisted default) no longer offered to
// the live default. Claude-Code-harness ids are translator-mapped, not catalog ids, and stay untouched.
const loadProviderModelsOnce = async (target: AgentProvider): Promise<void> => {
    providerModelsState.value = { ...providerModelsState.value, [target]: `loading` };
    let body: { models: Model[]; default: string };
    try {
        const response = await sandboxRequest(modelsPath(target));
        if (!response.ok) {
            providerModelsState.value = { ...providerModelsState.value, [target]: `error` };
            return;
        }
        body = (await response.json()) as { models: Model[]; default: string };
        if (!Array.isArray(body.models)) {
            providerModelsState.value = { ...providerModelsState.value, [target]: `error` };
            return;
        }
    } catch {
        // The daemon is unreachable/mid-restart; the picker shows the error row with a Retry.
        providerModelsState.value = { ...providerModelsState.value, [target]: `error` };
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
        })),
    };
    providerDefaultModel.value = { ...providerDefaultModel.value, [target]: body.default };
    // Moves an open chat off a model this catalog no longer offers (renamed, retired, or a rung the provider has
    // stopped serving) and back onto it when the next read lists it again. Reversible because the two cases are
    // indistinguishable from here: a routed channel de-lists a model for as long as it is out of capacity for it, and
    // a one-way repoint spends the rest of the conversation on a model the user never chose.
    const valid = new Set(body.models.map((entry) => entry.id));
    for (const conversation of conversations.value) {
        if (conversation.provider.value !== target) {
            continue;
        }
        const displaced = conversation.displacedModel.value;
        // Asked before the repoint, so a catalog that lists the owed pick again hands it back rather than moving the
        // chat a second time when the row it was parked on is the one that went.
        if (displaced !== undefined && valid.has(displaced)) {
            conversation.restoreModel();
            continue;
        }
        if (!valid.has(conversation.model.value)) {
            conversation.displaceModel(body.default);
        }
    }
    // The remembered pick (not the open chat's model, moved above) is never rewritten from a catalog: a thin catalog
    // read must not spend a standing preference for good. rememberedModelFor re-resolves it against the live list.
};

// Deduped per-provider via singleFlight, not by reading `providerModelsState` back as a mutex: that ref is
// presentation state (spinner/error row), and using it to gate a request let concurrent calls duplicate a fetch.
export const loadProviderModels = withConcurrency(loadProviderModelsOnce, { mode: `singleFlight`, key: (target) => target });

// Refreshes every native provider's catalog so cross-provider search has all lists warm; ACP providers have no
// daemon catalog. Safe to spam: in-flight providers collapse into their running load.
export const loadAllProviderModels = async (): Promise<void> => {
    await Promise.all(NATIVE_PROVIDERS.map((target) => loadProviderModels(target)));
};

// Reads the free trial's remaining allowance, separate from the capability read that discovers the trial exists
// (different clocks). A failure keeps the previous figures rather than zeroing them.
export const loadTrialStatus = async (): Promise<void> => {
    try {
        trialStatus.value = (await sandboxJson(`/endpoints/trial/status`)) as TrialStatusResponse;
    } catch {
        // Left as-is; the next reachable load asks again.
    }
};

// Re-reads the allowance once a turn settles, only for isTrialProvider: every other provider's count isn't this
// meter's business, and polling after those turns would return the same number.
watch(
    () => active.value.streaming.value,
    (isStreaming, was) => {
        if (was === true && !isStreaming && isTrialProvider(active.value.provider.value)) {
            void loadTrialStatus();
        }
    },
);

// Two capability kinds mint providers: `agent` (ACP agents; the row is the provider itself) and `endpoint` (model
// APIs with their own catalog, loaded right after). The `endpoint/` id prefix marks the full Claude Code loop
// (capabilitiesOf).
export const loadCapabilityProviders = async (): Promise<void> => {
    let entries: { id: string; kind: string; config: Record<string, unknown> }[];
    try {
        const body = (await sandboxJson(`/capabilities`)) as { capabilities?: { id: string; kind: string; config: Record<string, unknown> }[] };
        entries = body.capabilities ?? [];
    } catch {
        // Leave the last lists; the picker simply misses new providers until the next reachable load.
        return;
    }
    acpProviders.value = entries
        .filter((entry) => entry.kind === `agent`)
        .map((entry) => ({ id: entry.id, label: typeof entry.config[`name`] === `string` ? (entry.config[`name`] as string) : entry.id }));
    // Labelled by the capability's own name, except the daemon-provisioned trial, which uses TRIAL_LABEL.
    endpointProviders.value = entries
        .filter((entry) => entry.kind === `endpoint` || entry.kind === `localmodel`)
        .map((entry) => {
            const id = endpointProvider(entry.id);
            // Kind is kept: it's the only way to tell a local model from a remote server once both are `endpoint/<id>`.
            return {
                id,
                label: isTrialProvider(id) ? TRIAL_LABEL : entry.id,
                kind: entry.kind === `localmodel` ? (`localmodel` as const) : (`endpoint` as const),
            };
        });
    // Endpoint catalogs load on the same seam as native ones, not via loadAllProviderModels (fixed list).
    await Promise.all(endpointProviders.value.map((endpoint) => loadProviderModels(endpoint.id)));
    // Read last: catalogs must land first, or a chat moved onto the trial keeps an empty model id forever.
    await loadTrialStatus();
    // Set only once capabilities and the trial allowance are both known; skipped on failure so the seam retries.
    endpointsLoaded.value = true;
};

// Singleton per window (hotReload.ts): a hot-reload re-run would mint a second set of in-flight catalog reads.
reloadOnHotUpdate(import.meta);
