import {
    type AgentCommand,
    type AgentProvider,
    type CatalogOption,
    endpointIdOf,
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
import { ref } from "vue";

// Live per-sandbox catalogs (models, defaults, commands, installed ACP agents) and the label rules
// pickers read them through. Module state, not per-conversation, since a catalog belongs to the
// sandbox; useChat fills it on the reachable seam and resetChat clears it. Nothing here fetches, and
// nothing is synthesized: labels and badges are the provider's own words.

// A live-catalog model option; all fields optional since catalogs vary in how much they report
// (id-only rows render label-only).
export interface ModelOption extends CatalogOption {
    readonly efforts?: readonly string[];
    readonly description?: string;
    readonly badges?: readonly ModelBadge[];
}

// Seeds one slot per native provider; a missing key would silently read as undefined since
// AgentProvider is a bare string. `seed` runs per provider so no two share a mutable value.
export const perProvider = <T>(seed: (provider: NativeProvider) => T): Record<AgentProvider, T> =>
    Object.fromEntries(NATIVE_PROVIDERS.map((provider) => [provider, seed(provider)] as const));

// Daemon-owned model catalog per provider; empty only until the first load.
export const providerModels = ref<Record<AgentProvider, ModelOption[]>>(perProvider<ModelOption[]>(() => []));
// Each provider's daemon-resolved default model id; empty only until the first load.
export const providerDefaultModel = ref<Record<AgentProvider, string>>(perProvider(() => ``));
// Per-provider fetch state, so the picker can show a spinner/retry instead of a silently-empty list.
export type CatalogLoadState = "idle" | "loading" | "loaded" | "error";
export const providerModelsState = ref<Record<AgentProvider, CatalogLoadState>>(perProvider<CatalogLoadState>(() => `idle`));

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
export const providerCommands = ref<Record<AgentProvider, readonly AgentCommand[]>>(perProvider<readonly AgentCommand[]>(() => []));

// Installed ACP agent providers (id + label), loaded alongside accounts/models; empty until the first load.
export const acpProviders = ref<readonly { id: string; label: string }[]>([]);

// What's left of today's free trial; `available: false` is both "no trial" and "not loaded yet".
export const trialStatus = ref<{
    available: boolean;
    allowance: number;
    used: number;
    remaining: number;
    health: TrialHealth;
    resetsAt?: string;
    retryAt?: string;
    // The real model behind the trial's most recent message; the trial routes per message.
    servedModel?: string;
}>({
    available: false,
    allowance: 0,
    used: 0,
    remaining: 0,
    health: "unknown",
});

// Installed model endpoints; `kind` distinguishes local weights from a remote server, for display only.
export const endpointProviders = ref<readonly { id: string; label: string; kind: "endpoint" | "localmodel" }[]>([]);

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
export const endpointsLoaded = ref(false);

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

// A bare tier, which is what the Agent tool takes for a subagent's model: capitalized, never resolved to a
// version, since which build a tier points at is the harness's to decide.
const TIERS: ReadonlySet<string> = new Set([`opus`, `sonnet`, `haiku`, `fable`]);
const tierLabel = (modelId: string): string | undefined =>
    TIERS.has(modelId) ? `${modelId.charAt(0).toUpperCase()}${modelId.slice(1)}` : undefined;

// Label for a model id: the catalog option's label, else a bare tier, else the raw id (a custom model belongs
// to no catalog), else the provider name for an empty id.
export const modelLabelFor = (provider: AgentProvider, modelId: string): string => {
    const option = modelOptionsFor(provider).find((entry) => entry.value === modelId);
    if (option !== undefined) {
        return option.label;
    }
    return modelId === `` ? providerDisplayLabel(provider) : (tierLabel(modelId) ?? modelId);
};

// Provider tabs for account pickers, derived from PROVIDER_SPECS so a new provider always gets a tab.
export const providerTabs: readonly { value: AgentProvider; label: string }[] = PROVIDER_SPECS.map((spec) => ({
    value: spec.id,
    label: spec.accountLabel,
}));
