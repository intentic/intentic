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

/* WHAT EACH PROVIDER CAN RUN, AS THIS WINDOW LAST HEARD IT, the live per-provider catalogs (models, defaults,
 * slash commands, installed ACP agents) and the label rules every picker reads them through.
 *
 * Module state rather than per-conversation state, because a catalog is a property of the SANDBOX: every tab,
 * the suggested-session box and the settings pages show the same models, and a second conversation must not
 * re-fetch them. useChat fills these on the reachable seam (loadProviderModels / loadAcpProviders) and clears
 * them in resetChat; nothing here fetches, so this module stays free of the daemon client, which is what lets a
 * Conversation read it without importing useChat (a cycle).
 *
 * Nothing is ever synthesized locally: a model's label, description and badges are the provider's own words, so
 * a new release carries its own presentation with no code change here. */

// A live-catalog model option: the picker entry plus whatever the provider published about the model, the
// reasoning-effort tiers it accepts, its capability description, and capability badges. All optional because
// provider catalogs differ in how much they report; rows with ids alone render label-only.
export interface ModelOption extends CatalogOption {
    readonly efforts?: readonly string[];
    readonly description?: string;
    readonly badges?: readonly ModelBadge[];
}

// Seed one slot per native provider. AgentProvider is a bare string on the wire, so `Record<AgentProvider, T>`
// is `Record<string, T>` and a missing provider key is NOT a type error, it reads back as `undefined` and the
// provider silently loses its models, accounts or load state. Deriving every one of these records from the
// contract's own vocabulary is what makes adding a provider a single edit in NATIVE_PROVIDERS instead of a hunt
// through the literals below. `seed` runs per provider so no two share a mutable value.
export const perProvider = <T>(seed: (provider: NativeProvider) => T): Record<AgentProvider, T> =>
    Object.fromEntries(NATIVE_PROVIDERS.map((provider) => [provider, seed(provider)] as const));

// Every provider's model catalog is daemon-owned (one route, /providers/{provider}/models, live discovery
// with a persisted/seed floor, never empty) and loaded into these records, so
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
    // An unseeded provider key (an ACP agent) has no catalog, the agent owns its own model, so empty rides.
    const live = providerDefaultModel.value[provider] ?? ``;
    if (live !== ``) {
        return live;
    }
    return modelsFor(provider)[0]?.value ?? ``;
};

/* TWO ROWS, ONE NAME. A catalog can publish several ids under the SAME display name, and Cursor's does: `auto`
 * (the server-picked Auto) and `auto-smart` (Cursor Router, the same word with a different router and different
 * billing behind it) both arrive as "Auto". Rendered straight, that is a list offering the same choice twice,
 * where picking either is a guess and the checkmark is the only thing telling the user what they landed on.
 *
 * So a repeated label is qualified by the one thing that distinguishes those rows and that the vendor did
 * publish: the model id. Nothing is invented and no row is dropped, because these are genuinely different
 * models, and only the colliding rows carry the suffix, so a catalog that names its models distinctly reads
 * exactly as its vendor wrote it. */
const qualifyCollidingLabels = (options: readonly ModelOption[]): ModelOption[] => {
    const count = new Map<string, number>();
    for (const option of options) {
        count.set(option.label, (count.get(option.label) ?? 0) + 1);
    }
    return options.map((option) => ((count.get(option.label) ?? 0) > 1 ? { ...option, label: `${option.label} (${option.value})` } : option));
};

// The model options for a provider's picker/chip: the provider's live daemon catalog, with the static catalog
// as the pre-load floor (Claude's seeded versions; codex/grok empty). Harness-independent (the harness is a
// separate axis now). Shared by the composer pill and the menu bodies so their list + label logic can't drift.
export const modelOptionsFor = (provider: AgentProvider): ModelOption[] => {
    const live = providerModels.value[provider] ?? [];
    return qualifyCollidingLabels(live.length > 0 ? live : modelsFor(provider));
};

// The slash commands each provider last published daemon-side (GET /agent/commands). A conversation's OWN
// list, replaced by every `commands` frame its turns emit, stays authoritative once it has run one; this is
// the seed that makes the composer's `/` popover work BEFORE that, since a provider's commands are a property
// of the workspace, not of one conversation. Claude's is read on the reachable seam beside accounts/models;
// every other provider's is read by the composer that needs it, and so is Claude's when that seam came back
// empty because the daemon had not served a turn yet (useChat.ensureProviderCommands).
export const providerCommands = ref<Record<AgentProvider, readonly AgentCommand[]>>(perProvider<readonly AgentCommand[]>(() => []));

// Installed ACP agent providers (agent-kind capabilities): id + display label, loaded on the same reachable
// seam as accounts/models (useChat.loadCapabilityProviders) so the picker lists them. Empty until the first load.
export const acpProviders = ref<readonly { id: string; label: string }[]>([]);

/* WHAT IS LEFT OF TODAY'S FREE TRIAL, or that there isn't one. Module state beside the catalogs for the same
 * reason they are: the allowance belongs to the ACCOUNT, not to a conversation, so every tab and every picker
 * must show the same number and a second conversation must not re-fetch it.
 *
 * `available` false is the ordinary answer, most sandboxes run against a platform that serves no trial, and
 * it is also the pre-load state, which is the safe way round: a picker that has not heard yet offers no trial
 * rather than promising an allowance that may not exist. */
export const trialStatus = ref<{
    available: boolean;
    allowance: number;
    used: number;
    remaining: number;
    health: TrialHealth;
    resetsAt?: string;
    retryAt?: string;
    // The real model behind the trial's one published row, on the most recent message. The trial routes per
    // message, so this is what turns "Free trial" from a black box into something a person can report a bug about.
    servedModel?: string;
}>({
    available: false,
    allowance: 0,
    used: 0,
    remaining: 0,
    health: "unknown",
});

// Installed model endpoints (endpoint-kind capabilities), as their `endpoint/<id>` provider ids, loaded on the
// same seam and from the same /capabilities read. Unlike an ACP agent, each of these HAS a catalog: the models
// come from the endpoint's own server, so they land in providerModels like every other provider's.
//
// `kind` rides along because the two families are one provider to everything that ROUTES a turn and two
// different things to a person reading the list: weights running on their own hardware here, versus a server
// somewhere they pointed us at. Nothing in the provider id says which, so the picker's glyph would have to
// guess (see ProviderLogo) if the capability's kind were dropped on the way in.
export const endpointProviders = ref<readonly { id: string; label: string; kind: "endpoint" | "localmodel" }[]>([]);

/* WHICH GLYPH STANDS IN FOR A PROVIDER WITH NO BRAND MARK, the one place that decision is made (ProviderLogo
 * draws it; the rail, the rows, the composer pill and the account panel all draw ProviderLogo).
 *
 * Everything here used to fall to one `sparkles`, which made the free trial, a locally-run model and a
 * user-added server indistinguishable in a rail whose whole job is telling providers apart. */
export const providerGlyph = (provider: AgentProvider): "gift" | "cpu" | "server" | "sparkles" => {
    if (isTrialProvider(provider)) {
        return `gift`;
    }
    const endpoint = endpointProviders.value.find((entry) => entry.id === provider);
    if (endpoint !== undefined) {
        return endpoint.kind === `localmodel` ? `cpu` : `server`;
    }
    // An installed ACP agent (or a provider we have not heard of yet): the agent brings its own model and its
    // own vendor, and nothing here knows either, so the generic "an AI runs this" glyph is the honest one.
    return `sparkles`;
};

/* Whether the CAPABILITY half of the picture has been read: which endpoints exist, and, for the trial, how much
 * of today's allowance is left. `accountsLoaded` is the same flag for the other half, and the two are not one
 * because they land on different reads, at very different speeds.
 *
 * That gap is what put a sign-in wall in front of every new user. The account reads come back off the daemon
 * quickly and flip `accountsLoaded`; the trial takes a capability read, a per-endpoint catalog fetch and a
 * round-trip to the platform. In between, "you have connected nothing" was allowed to be true, and the first
 * screen of the product painted a Google pitch over a free channel that was already on its way. A claim that
 * has to be retracted a second later is worse than a spinner, so both halves vote (see accessKnown). */
export const endpointsLoaded = ref(false);

/* The display label for any provider: a capability-derived provider's own name when known (an ACP agent's
 * configured display name, an endpoint's capability id), then the capability id of an endpoint whose card is
 * GONE, else the shared static label, which itself falls back to the raw id.
 *
 * That third rung exists for the spend ledger, the one surface that outlives a card: it names providers nobody
 * can connect any more, and `endpoint/llama-test` is a provider id printed where a name goes. Stripping the
 * prefix says the same thing in the words the user typed when they added it. */
export const providerDisplayLabel = (provider: AgentProvider): string =>
    acpProviders.value.find((agent) => agent.id === provider)?.label ??
    endpointProviders.value.find((endpoint) => endpoint.id === provider)?.label ??
    endpointIdOf(provider) ??
    providerLabel(provider);

/* LOCALLY-RUN WEIGHTS ARE ONE PROVIDER TO A READER, however many cards mint them, and this is the single rule
 * that says which providers those are. Two surfaces fold on it: the picker's rail and sections (one lane to
 * choose among, see lanesOf) and the Usage tab's filter, chart and legend (one series to read a cost screen
 * by). They agreed on the concept and disagreed on the answer before this was shared: the picker folded and
 * the ledger drew a pill per card.
 *
 * A card that is GONE folds in too, and that is the deliberate part. The ledger keeps every provider it ever
 * billed and is never pruned (money that shrinks is worse than money that is stale), so a sandbox that tried
 * three sets of weights and deleted them carries three dead provider ids for good. Nothing in a ledger row says
 * which KIND of card minted it, so the live capability list is the only thing that can tell a local model from
 * a remote server, and for a deleted id it says nothing at all. Folding the unknown in with the local models is
 * the reading that is right for what actually produces dead endpoint ids, weights you tried for an afternoon;
 * a remote endpoint is a server you point at once and keep. It is a display grouping and nothing routes on it,
 * so the cost of being wrong is a deleted gateway's spend sitting under the wrong heading.
 *
 * The trial is excluded by name: it is an endpoint the daemon provisioned, not a model on this machine. */
export const LOCAL_MODELS_GROUP = "local-models";
const LOCAL_MODELS_LABEL = "Local models";

export const isLocalModelProvider = (provider: AgentProvider): boolean =>
    isEndpointProvider(provider) &&
    !isTrialProvider(provider) &&
    (endpointProviders.value.find((endpoint) => endpoint.id === provider)?.kind ?? `localmodel`) === `localmodel`;

// The group a provider is READ under: itself, unless it is one of the locally-run models.
export const providerGroup = (provider: AgentProvider): string => (isLocalModelProvider(provider) ? LOCAL_MODELS_GROUP : provider);

// What that group is called. Takes a group key, not a provider: the folded one belongs to no single card.
export const providerGroupLabel = (group: string): string => (group === LOCAL_MODELS_GROUP ? LOCAL_MODELS_LABEL : providerDisplayLabel(group));

// The display label for a selected model id, the option's label, else the raw id, else the provider name. The
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

/* The provider tabs shown wherever accounts are picked (the account dialog + the composer's connect gate).
 * Labels differ from the internal ids (codex → "ChatGPT") and from the model picker's (claude → "Claude", not
 * "Claude Code"), because this list answers "whose account is this" and the picker answers "which runtime is
 * this": ProviderSpec.accountLabel is the first of those, and its comment says why the two are separate fields.
 *
 * DERIVED, and that is the point: this was the last hand-kept list of providers on this side of the wire, so a
 * provider added to the contract appeared in the model picker and in the rail and simply had no tab to connect
 * it on — visible, unrunnable, and nothing failing anywhere to say so. */
export const providerTabs: readonly { value: AgentProvider; label: string }[] = PROVIDER_SPECS.map((spec) => ({
    value: spec.id,
    label: spec.accountLabel,
}));
