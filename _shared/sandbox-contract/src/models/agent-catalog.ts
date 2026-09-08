import { ACP, type AgentCapabilities, CLAUDE_CODE, PI } from "./agent-runtimes.js";
import { type NativeProvider, PROVIDER_SPECS, type ProviderAccess, providerSpec } from "./provider-specs.js";
import type { AgentHarness, AgentProvider, PermissionMode } from "../schemas/agent.js";
import type { Model, ModelBadge } from "../schemas/provider-oauth.js";

// The provider/harness/model catalog every picker shares, pure data keyed by the wire vocabulary in schemas/agent.ts.
// Every table below is derived from PROVIDER_SPECS; what remains here is the shape each surface wants, plus rules about
// something other than a provider (trial, endpoint namespace, effort/fast-mode gates).

export interface CatalogOption {
    readonly label: string;
    readonly value: string;
}

// Native runtimes only; ACP providers are appended by the consumer. Order is the spec table's own.
export const PROVIDERS: readonly { label: string; value: NativeProvider }[] = PROVIDER_SPECS.map((spec) => ({
    label: spec.label,
    value: spec.id,
}));

// What a provider costs to unlock and what the user connects for it; the axis the picker groups rows on.
export const PROVIDER_ACCESS: Record<NativeProvider, ProviderAccess> = Object.fromEntries(
    PROVIDER_SPECS.map((spec) => [spec.id, spec.access] as const),
) as Record<NativeProvider, ProviderAccess>;

// Providers that cost nothing; derived, so a channel losing free status stops being promoted automatically.
export const FREE_PROVIDERS: readonly NativeProvider[] = PROVIDER_SPECS.filter((spec) => spec.access.kind === "free").map((spec) => spec.id);
export const isFreeProvider = (provider: AgentProvider): boolean => FREE_PROVIDERS.includes(provider as NativeProvider);

// Whose allowance a turn on this provider spends, as the subject of a sentence.
export const PROVIDER_VENDOR: Record<NativeProvider, string> = Object.fromEntries(
    PROVIDER_SPECS.map((spec) => [spec.id, spec.vendor] as const),
) as Record<NativeProvider, string>;

// An `endpoint/<id>` provider is a model API the user pointed at, opposite in kind from an ACP agent. A slash, never a
// colon, since `provider:model` is the picker's own key shape.
// The trial's endpoint id, reserved like `pi`; daemon-provisioned, riding the endpoint kind so no new turn path or
// adapter was needed. Every surface must disclose it: a trial passes through intentic's own servers.
export const TRIAL_ENDPOINT_ID = "free-trial";
export const TRIAL_PROVIDER = "endpoint/free-trial";
export const isTrialProvider = (provider: AgentProvider): boolean => provider === TRIAL_PROVIDER;

// A synthetic id, never changing; which real model answers is decided per message by the platform alone.
export const TRIAL_MODEL_ID = "auto";
// One wording for both the picker's label and the composer's notice, so they can't describe different bargains.
export const TRIAL_LABEL = "Free trial";
export const TRIAL_NOTICE = "Trial messages pass through intentic. Connect an account to chat directly.";

export const ENDPOINT_PROVIDER_PREFIX = "endpoint/";
export const endpointProvider = (id: string): AgentProvider => `${ENDPOINT_PROVIDER_PREFIX}${id}`;
export const isEndpointProvider = (provider: AgentProvider): boolean => provider.startsWith(ENDPOINT_PROVIDER_PREFIX);
// The capability id behind an endpoint provider; undefined when the provider is not one.
export const endpointIdOf = (provider: AgentProvider): string | undefined =>
    isEndpointProvider(provider) ? provider.slice(ENDPOINT_PROVIDER_PREFIX.length) : undefined;

// An ACP provider or an endpoint has no access requirement: both are already runnable once installed/configured. What a
// turn on it costs is deliberately not claimed, since the daemon has no way to know.
export const accessFor = (provider: AgentProvider): ProviderAccess | undefined => providerSpec(provider)?.access;

// An ACP provider's label is its capability's display name, which the web layers on top, the raw id is the static
// fallback.
export const providerLabel = (provider: AgentProvider): string => providerSpec(provider)?.label ?? provider;

// Whether a plan-limit reading is obtainable at all for this provider.
export const PLAN_LIMIT_PROVIDERS: readonly NativeProvider[] = PROVIDER_SPECS.filter((spec) => spec.planLimits).map((spec) => spec.id);
export const reportsPlanLimits = (provider: AgentProvider): boolean => PLAN_LIMIT_PROVIDERS.includes(provider as NativeProvider);

// `native` is the provider's own runtime; `claude-code` runs it through that loop instead, for any provider.
export const HARNESSES: readonly { label: string; value: AgentHarness }[] = [
    { label: "Native", value: "native" },
    { label: "Claude Code", value: "claude-code" },
];

// Whether the harness axis is a real choice for this provider, or a switch whose two positions run the same loop.
// Derived, so a provider that gains a native runtime tomorrow gains the switch with it.
export const harnessChoosable = (provider: AgentProvider): boolean => {
    const spec = providerSpec(provider);
    return spec !== undefined && spec.runtimes.native.runtime !== spec.runtimes.claudeCode.runtime;
};

// Maps (provider, harness) to a record: a native spec row, an `endpoint/<id>` at the Claude Code loop's ceiling, `pi`
// at its own RPC runtime, anything else over ACP. Naming one record on both harnesses is a fact, not a preference.
export const capabilitiesOf = (provider: AgentProvider, harness: AgentHarness): AgentCapabilities => {
    const spec = providerSpec(provider);
    if (spec !== undefined) {
        return harness === "claude-code" ? spec.runtimes.claudeCode : spec.runtimes.native;
    }
    if (isEndpointProvider(provider)) {
        return CLAUDE_CODE;
    }
    if (provider === PI_PROVIDER) {
        return PI;
    }
    return ACP;
};

// Reserved like a native id: an `agent`-kind capability installed under it is served over Pi's RPC, not ACP.
export const PI_PROVIDER = "pi";

// Which permission modes a runtime can actually be put in. Under "plan" every other mode collapses onto the autonomous
// posture the runtime already runs, so offering them would be four names for two behaviours.
export const modesFor = (capabilities: AgentCapabilities): readonly PermissionMode[] =>
    capabilities.permissions === "modes" ? ["default", "acceptEdits", "plan", "bypassPermissions"] : ["plan", "bypassPermissions"];

// The mode a selection falls back to when the runtime can't hold it, the same shape as clampEffort: a provider switch
// must not leave the composer showing a posture nothing applies.
export const clampMode = (mode: PermissionMode, capabilities: AgentCapabilities): PermissionMode =>
    modesFor(capabilities).includes(mode) ? mode : "bypassPermissions";

// What this pair cannot do, phrased for the sender; empty means the full ceiling. `fastMode` is deliberately not
// disclosed here, since it also depends on the route and model; fastAllowed answers that instead.
export const limitationsOf = (capabilities: AgentCapabilities): string[] => [
    ...(capabilities.permissions === "plan" ? ["no per-tool approvals"] : []),
    ...(capabilities.questions ? [] : ["no clarifying questions"]),
    ...(capabilities.steering ? [] : ["no mid-turn steering"]),
    ...(capabilities.mcp === "none"
        ? ["no MCP tools or plugins"]
        : capabilities.mcp === "http"
          ? ["MCP tools only, no plugins or browser"]
          : capabilities.mcp === "browser"
            ? ["browser tools only, no other MCP"]
            : capabilities.mcp === "tools"
              ? ["no plugins"]
              : []),
    ...(capabilities.execution.includes("js") ? [] : ["no code runs, shell only"]),
    ...(capabilities.effort ? [] : ["no effort control"]),
    ...(capabilities.commands ? [] : ["no slash commands"]),
    ...(capabilities.terminals ? [] : ["no terminal panel"]),
    ...(capabilities.isolation === "namespace" ? [] : ["worktree by cwd only"]),
    ...(capabilities.recovery ? [] : ["no auto-resume after outage"]),
    ...(capabilities.instructions === "append" ? ["system prompt appended, not replaced"] : []),
    ...(capabilities.instructions === "none" ? ["system prompt not applied"] : []),
    ...(capabilities.rulebook === "approval" ? ["command rules apply only to calls this agent raises"] : []),
    ...(capabilities.rulebook === "refuse-only" ? ["command rules can refuse but not hold"] : []),
    ...(capabilities.rulebook === "none" ? ["command rules not applied"] : []),
    ...(capabilities.secrets === "none" ? ["secrets reach the model unmasked"] : []),
];

// Claude's compile-time model floor, shared by daemon and web pre-load; versioned ids only, never a tier alias.
export const CLAUDE_SEED_MODELS: readonly Model[] = [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

// The static floor of the model catalog, harness-independent; every provider's real list is the daemon's live catalog
// layered on top. Empty for every provider but Claude: nothing sensible to offer before the first live load.
export const modelsFor = (provider: AgentProvider): CatalogOption[] => {
    if (provider === "claude") {
        return CLAUDE_SEED_MODELS.map((model) => ({ label: model.label, value: model.id }));
    }
    // Every other provider's floor lives with the daemon's live catalog, not here: no second list to keep in sync.
    return [];
};

// Filters exactly one pair: Claude's `max` with thinking explicitly false, the one combination Anthropic's API refuses
// (400). Absent thinking is not off; the model's own default answers, every other tier or provider passes through.
export const effortAllowed = (effort: string, provider: AgentProvider, thinking: boolean | undefined): boolean =>
    effort !== "max" || provider !== "claude" || thinking !== false;

// The same rule applied as a repair, not a filter: a route, extension, restored tab or pinned model can all bypass the
// picker. The tier moves, not the thinking setting, since turning thinking off was the user's own deliberate choice.
export const sendableEffort = (effort: string | undefined, thinking: boolean | undefined): string | undefined =>
    effort === "max" && thinking === false ? "high" : effort;

// Covers the case sendableEffort doesn't: `max` with no thinking setting at all, the common case, where the model's own
// default would otherwise decide and vary by model. A thinking setting the user did set (even off) is left alone.
export const sendableThinking = (effort: string | undefined, thinking: boolean | undefined): boolean | undefined =>
    effort === "max" && thinking === undefined ? true : thinking;

// Fast speed needs all three: the runtime can ask (Claude Code loop only), the route is first-party (not the translator
// or a non-Anthropic endpoint), and the model publishes the `fast` badge. Absent badges reads as false.
export const fastAllowed = (capabilities: AgentCapabilities, provider: AgentProvider, badges: readonly ModelBadge[] | undefined): boolean =>
    capabilities.fastMode && provider === "claude" && (badges ?? []).includes("fast");
