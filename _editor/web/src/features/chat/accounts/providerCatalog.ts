import { sandboxRef, sandboxValue } from "@intentic/extension-api";
import {
    type AgentCommand,
    type AgentProvider,
    type CatalogOption,
    endpointIdOf,
    humanizeModelId,
    isEndpointProvider,
    isTrialProvider,
    type ModelBadge,
    modelsFor,
    NATIVE_PROVIDERS,
    type NativeProvider,
    PROVIDER_SPECS,
    providerLabel,
    type TrialHealth,
} from "@intentic/sandbox-contract";

// Live per-sandbox catalogs (models, defaults, commands, installed ACP agents) and the label rules
// pickers read them through. Module state, not per-conversation, since a catalog belongs to the
// sandbox; useChat fills it on the reachable seam, a label asked of an unread catalog fills it on demand
// (modelLabelFor), and a switch clears it with the scope. Labels and badges are the provider's own words where it has any.

// A live-catalog model option; all fields optional since catalogs vary in how much they report
// (id-only rows render label-only).
export interface ModelOption extends CatalogOption {
    readonly efforts?: readonly string[];
    readonly description?: string;
    readonly badges?: readonly ModelBadge[];
    // Epoch seconds: every credential that serves this model is refused until then. A fact about the model, which is
    // why no account ring can show it — a routed provider picks the credential itself.
    readonly availableAt?: number;
}

// Seeds one slot per native provider; a missing key would silently read as undefined since
// AgentProvider is a bare string. `seed` runs per provider so no two share a mutable value.
export const perProvider = <T>(seed: (provider: NativeProvider) => T): Record<AgentProvider, T> =>
    Object.fromEntries(NATIVE_PROVIDERS.map((provider) => [provider, seed(provider)] as const));

// Daemon-owned model catalog per provider; empty only until the first load.
export const providerModels = sandboxRef<Record<AgentProvider, ModelOption[]>>(() => perProvider<ModelOption[]>(() => []));
// Each provider's daemon-resolved default model id; empty only until the first load.
export const providerDefaultModel = sandboxRef<Record<AgentProvider, string>>(() => perProvider(() => ``));
// Per-provider fetch state, so the picker can show a spinner/retry instead of a silently-empty list.
export type CatalogLoadState = "idle" | "loading" | "loaded" | "error";
export const providerModelsState = sandboxRef<Record<AgentProvider, CatalogLoadState>>(() => perProvider<CatalogLoadState>(() => `idle`));

// The model a fresh conversation seeds; harness-independent, since codex/grok run the same ids either
// way. Falls back to the live catalog's first entry before the daemon default has loaded.
export const defaultModelFor = (provider: AgentProvider): string => {
    // An unseeded provider key (an ACP agent) has no catalog; the agent owns its own model, so empty rides.
    const live = providerDefaultModel.value[provider] ?? ``;
    if (live !== ``) {
        return live;
    }
    return modelsFor(provider)[0]?.value ?? ``;
};

// A catalog can publish two ids under the same label (Cursor's `auto`/`auto-smart` both say "Auto");
// only colliding rows get the id appended to disambiguate.
const qualifyCollidingLabels = (options: readonly ModelOption[]): ModelOption[] => {
    const count = new Map<string, number>();
    for (const option of options) {
        count.set(option.label, (count.get(option.label) ?? 0) + 1);
    }
    return options.map((option) => ((count.get(option.label) ?? 0) > 1 ? { ...option, label: `${option.label} (${option.value})` } : option));
};

// Model options for a provider's picker/chip: live catalog over the static pre-load floor. Shared by
// the composer pill and menu bodies so list and label logic can't drift.
export const modelOptionsFor = (provider: AgentProvider): ModelOption[] => {
    const live = providerModels.value[provider] ?? [];
    return qualifyCollidingLabels(live.length > 0 ? live : modelsFor(provider));
};

// Slash commands last published per provider, seeding the composer's `/` popover.
export const providerCommands = sandboxRef<Record<AgentProvider, readonly AgentCommand[]>>(() => perProvider<readonly AgentCommand[]>(() => []));

// Installed ACP agent providers (id + label), loaded alongside accounts/models; empty until the first load.
export const acpProviders = sandboxRef<readonly { id: string; label: string }[]>(() => []);

// Native providers the daemon says can run a turn right now. The account lists answer the same question for anyone
// who may read them; this is the answer for a tier that may drive a turn but not see what the box is signed in as —
// a guest, which was otherwise told to connect a provider this sandbox already holds.
export const nativeReady = sandboxRef<readonly AgentProvider[]>(() => []);

// What's left of today's free trial; `available: false` is both "no trial" and "not loaded yet".
export const trialStatus = sandboxRef<{
    available: boolean;
    allowance: number;
    used: number;
    remaining: number;
    health: TrialHealth;
    resetsAt?: string;
    retryAt?: string;
    // The real model behind the trial's most recent message; the trial routes per message.
    servedModel?: string;
}>(() => ({
    available: false,
    allowance: 0,
    used: 0,
    remaining: 0,
    health: "unknown",
}));

// Installed model endpoints; `kind` distinguishes local weights from a remote server, for display only.
export const endpointProviders = sandboxRef<readonly { id: string; label: string; kind: "endpoint" | "localmodel" }[]>(() => []);

// Which glyph stands in for a provider with no brand mark; the one place that decision is made
// (ProviderLogo draws it).
export const providerGlyph = (provider: AgentProvider): "gift" | "cpu" | "server" | "sparkles" => {
    if (isTrialProvider(provider)) {
        return `gift`;
    }
    const endpoint = endpointProviders.value.find((entry) => entry.id === provider);
    if (endpoint !== undefined) {
        return endpoint.kind === `localmodel` ? `cpu` : `server`;
    }
    // An ACP agent or unknown provider: nothing here knows its vendor, so the generic glyph is honest.
    return `sparkles`;
};

// Whether the capability half (endpoints, trial allowance) has loaded, separately from `accountsLoaded`.
export const endpointsLoaded = sandboxRef(() => false);

// Display label for any provider, falling back through ACP/endpoint name, a gone endpoint's raw id,
// then the static label. The raw-id rung exists for the spend ledger, which outlives a deleted card.
export const providerDisplayLabel = (provider: AgentProvider): string =>
    acpProviders.value.find((agent) => agent.id === provider)?.label ??
    endpointProviders.value.find((endpoint) => endpoint.id === provider)?.label ??
    endpointIdOf(provider) ??
    providerLabel(provider);

// All locally-run weights read as one provider (used by the picker's rail and the Usage tab's
// legend), including a card that's since been deleted. The trial is excluded: it's a
// daemon-provisioned endpoint, not local weights.
export const LOCAL_MODELS_GROUP = "local-models";
const LOCAL_MODELS_LABEL = "Local models";

export const isLocalModelProvider = (provider: AgentProvider): boolean =>
    isEndpointProvider(provider) &&
    !isTrialProvider(provider) &&
    (endpointProviders.value.find((endpoint) => endpoint.id === provider)?.kind ?? `localmodel`) === `localmodel`;

// The group a provider reads under: itself, unless it's one of the locally-run models.
export const providerGroup = (provider: AgentProvider): string => (isLocalModelProvider(provider) ? LOCAL_MODELS_GROUP : provider);

// What a group is called; takes a group key, not a provider, since the folded group has no single card.
export const providerGroupLabel = (group: string): string => (group === LOCAL_MODELS_GROUP ? LOCAL_MODELS_LABEL : providerDisplayLabel(group));

// A failed catalog read is asked again no sooner than this, however often a render names a model on it.
const DEMAND_RETRY_MS = 30_000;

// What reads one provider's catalog, registered by the loader (useChat-catalog.ts), which reads this module's state and
// so cannot be imported by it; unset where no loader runs, which leaves an unread catalog's labels to the humanizer.
let catalogReader: ((provider: AgentProvider) => unknown) | undefined;
export const readCatalogsWith = (reader: (provider: AgentProvider) => unknown): void => {
    catalogReader = reader;
};

// When a label last asked for each provider's catalog; plain state, since it is written from inside renders.
const demanded = sandboxValue(() => new Map<AgentProvider, number>());

// Reads the catalog a label found nothing in, when nothing has read it yet or its last read failed. Only native
// providers and endpoints publish one; an ACP agent names its own models.
const demandCatalog = (provider: AgentProvider): void => {
    const state = providerModelsState.value[provider];
    if (state === `loading` || state === `loaded` || (!NATIVE_PROVIDERS.includes(provider as NativeProvider) && !isEndpointProvider(provider))) {
        return;
    }
    const last = demanded.value.get(provider);
    if (last !== undefined && Date.now() - last < DEMAND_RETRY_MS) {
        return;
    }
    demanded.value.set(provider, Date.now());
    // Off the render that asked: the read writes the load state that render depends on.
    queueMicrotask(() => catalogReader?.(provider));
};

// The one way the app names a model, by its catalog's label; asking of an unread catalog reads it, and until it lands, or
// for an id none lists (a custom pin, a tier alias), the id reads through the contract's humanizeModelId, as daemon-side.
export const modelLabelFor = (provider: AgentProvider, modelId: string): string => {
    if (modelId === ``) {
        return providerDisplayLabel(provider);
    }
    const option = modelOptionsFor(provider).find((entry) => entry.value === modelId);
    if (option !== undefined) {
        return option.label;
    }
    demandCatalog(provider);
    return humanizeModelId(modelId);
};

// Provider tabs for account pickers, derived from PROVIDER_SPECS so a new provider always gets a tab.
export const providerTabs: readonly { value: AgentProvider; label: string }[] = PROVIDER_SPECS.map((spec) => ({
    value: spec.id,
    label: spec.accountLabel,
}));
