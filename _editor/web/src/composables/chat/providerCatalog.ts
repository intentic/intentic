import {
    type AgentCommand,
    type AgentProvider,
    type CatalogOption,
    type ModelBadge,
    modelsFor,
    NATIVE_PROVIDERS,
    type NativeProvider,
    providerLabel,
} from "@intentic/sandbox-contract";
import { ref } from "vue";

/* WHAT EACH PROVIDER CAN RUN, AS THIS WINDOW LAST HEARD IT — the live per-provider catalogs (models, defaults,
 * slash commands, installed ACP agents) and the label rules every picker reads them through.
 *
 * Module state rather than per-conversation state, because a catalog is a property of the SANDBOX: every tab,
 * the suggested-session dialog and the settings pages show the same models, and a second conversation must not
 * re-fetch them. useChat fills these on the reachable seam (loadProviderModels / loadAcpProviders) and clears
 * them in resetChat; nothing here fetches, so this module stays free of the daemon client — which is what lets a
 * Conversation read it without importing useChat (a cycle).
 *
 * Nothing is ever synthesized locally: a model's label, description and badges are the provider's own words, so
 * a new release carries its own presentation with no code change here. */

// A live-catalog model option: the picker entry plus whatever the provider published about the model — the
// reasoning-effort tiers it accepts, its capability description, and capability badges. All optional because
// provider catalogs differ in how much they report; rows with ids alone render label-only.
export interface ModelOption extends CatalogOption {
    readonly efforts?: readonly string[];
    readonly description?: string;
    readonly badges?: readonly ModelBadge[];
}

// Seed one slot per native provider. AgentProvider is a bare string on the wire, so `Record<AgentProvider, T>`
// is `Record<string, T>` and a missing provider key is NOT a type error — it reads back as `undefined` and the
// provider silently loses its models, accounts or load state. Deriving every one of these records from the
// contract's own vocabulary is what makes adding a provider a single edit in NATIVE_PROVIDERS instead of a hunt
// through the literals below. `seed` runs per provider so no two share a mutable value.
export const perProvider = <T>(seed: (provider: NativeProvider) => T): Record<AgentProvider, T> =>
    Object.fromEntries(NATIVE_PROVIDERS.map((provider) => [provider, seed(provider)] as const));

// Every provider's model catalog is daemon-owned (/claude/models · /codex/models · /grok/models · /kimi/models ·
// /gemini/models — live discovery with a persisted/seed floor, never empty) and loaded into these records, so
// the pickers track provider renames and new releases without a static list. useChat.loadProviderModels fills
// them when a daemon is reachable; resetChat clears. Empty only until the first load.
export const providerModels = ref<Record<AgentProvider, ModelOption[]>>(perProvider<ModelOption[]>(() => []));
// Each provider's daemon-resolved default model id; empty only until the first load.
export const providerDefaultModel = ref<Record<AgentProvider, string>>(perProvider(() => ``));
// Per-provider catalog fetch state, so the picker can show a spinner/retry per provider group instead of a
// silently-empty list (every provider but Claude has no static floor to fall back on before its first load).
export type CatalogLoadState = "idle" | "loading" | "loaded" | "error";
export const providerModelsState = ref<Record<AgentProvider, CatalogLoadState>>(perProvider<CatalogLoadState>(() => `idle`));

// The model a fresh conversation seeds for a provider. Harness-independent: codex/grok run the SAME subscription
// model ids natively and under the Claude Code harness (the translator serves them), so the catalog no longer
// forks by harness. Every provider names its live daemon default; before the first catalog load it takes the
// head of the same static floor the picker shows (Claude's newest seeded version; codex/grok empty, so the
// daemon resolves its own default). Reading the floor rather than naming an id here is what keeps the seeded
// model a row the picker actually offers.
export const defaultModelFor = (provider: AgentProvider): string => {
    // An unseeded provider key (an ACP agent) has no catalog — the agent owns its own model, so empty rides.
    const live = providerDefaultModel.value[provider] ?? ``;
    if (live !== ``) {
        return live;
    }
    return modelsFor(provider)[0]?.value ?? ``;
};

// The model options for a provider's picker/chip: the provider's live daemon catalog, with the static catalog
// as the pre-load floor (Claude's seeded versions; codex/grok empty). Harness-independent (the harness is a
// separate axis now). Shared by the composer pill and the menu bodies so their list + label logic can't drift.
export const modelOptionsFor = (provider: AgentProvider): ModelOption[] => {
    const live = providerModels.value[provider] ?? [];
    return live.length > 0 ? live : modelsFor(provider);
};

// The slash commands each provider last published daemon-side (GET /agent/commands), loaded on the same
// reachable seam as accounts/models. A conversation's OWN list — replaced by every `commands` frame its turns
// emit — stays authoritative once it has run one; this is the seed that makes the composer's `/` popover work
// BEFORE that, since a provider's commands are a property of the workspace, not of one conversation. Empty
// until the first load, and until that provider has run a turn in the daemon's lifetime.
export const providerCommands = ref<Record<AgentProvider, readonly AgentCommand[]>>(perProvider<readonly AgentCommand[]>(() => []));

// Installed ACP agent providers (agent-kind capabilities): id + display label, loaded on the same reachable
// seam as accounts/models (useChat.loadCapabilityProviders) so the picker lists them. Empty until the first load.
export const acpProviders = ref<readonly { id: string; label: string }[]>([]);

// Installed model endpoints (endpoint-kind capabilities), as their `endpoint/<id>` provider ids — loaded on the
// same seam and from the same /capabilities read. Unlike an ACP agent, each of these HAS a catalog: the models
// come from the endpoint's own server, so they land in providerModels like every other provider's.
export const endpointProviders = ref<readonly { id: string; label: string }[]>([]);

// The display label for any provider: a capability-derived provider's own name when known (an ACP agent's
// configured display name, an endpoint's capability id), else the shared static label — which itself falls back
// to the raw id.
export const providerDisplayLabel = (provider: AgentProvider): string =>
    acpProviders.value.find((agent) => agent.id === provider)?.label ??
    endpointProviders.value.find((endpoint) => endpoint.id === provider)?.label ??
    providerLabel(provider);

// The display label for a selected model id — the option's label, else the raw id, else the provider name. The
// raw-id rung is what a custom model rides on: it belongs to no catalog by definition, and naming the provider
// there would hide WHICH model the turn actually runs. The provider name remains the floor for an EMPTY id, so
// the chip is never blank (Grok's catalog can be briefly empty on first load; an ACP agent owns its own model
// and carries no id at all).
export const modelLabelFor = (provider: AgentProvider, modelId: string): string => {
    const option = modelOptionsFor(provider).find((entry) => entry.value === modelId);
    if (option !== undefined) {
        return option.label;
    }
    return modelId === `` ? providerDisplayLabel(provider) : modelId;
};

// The provider tabs shown wherever accounts are picked (the account dialog + the composer's connect gate).
// Labels differ from the internal ids (codex → "ChatGPT").
export const providerTabs: readonly { value: AgentProvider; label: string }[] = [
    { value: `claude`, label: `Claude` },
    { value: `codex`, label: `ChatGPT` },
    { value: `grok`, label: `Grok` },
    { value: `kimi`, label: `Kimi Code` },
    { value: `gemini`, label: `Google` },
];
