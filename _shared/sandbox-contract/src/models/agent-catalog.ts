import { ACP, type AgentCapabilities, CLAUDE_CODE, CODEX, MUSE, OPENCODE, PI } from "./agent-runtimes.js";
import { type LoopTerms, type NativeProvider, PROVIDER_SPECS, type ProviderAccess, type ProviderLoops, providerSpec } from "./provider-specs.js";
import type { AgentHarness, AgentLoop, AgentProvider, PermissionMode } from "../schemas/agent.js";
import type { Model, ModelBadge } from "../schemas/providers/provider-oauth.js";

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
// What the daemon and the trial endpoint call the free trial; the web says it in the reader's language.
export const TRIAL_LABEL = "Free trial";

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

// Every value the harness axis takes, in the wire enum's order; `native` names whichever loop the provider defaults to.
// Labels are the loops' own names, except `vendor`, which only a provider can name (loopLabel).
export const HARNESSES: readonly { label: string; value: AgentHarness }[] = [
    { label: "Native", value: "native" },
    { label: "Claude Code", value: "claude-code" },
    { label: "Codex", value: "codex" },
    { label: "OpenCode", value: "opencode" },
    { label: "Pi", value: "pi" },
    { label: "Muse Code", value: "muse" },
    { label: "Own agent", value: "vendor" },
];

// Reserved like a native id: an `agent`-kind capability installed under it is served over Pi's RPC, not ACP.
export const PI_PROVIDER = "pi";

// The loops of everything that is not a spec row, said once: an `endpoint/<id>` defaults to Claude Code (the loop that
// speaks Anthropic Messages to any base) and also runs on Codex (Responses, through the translator's entry for it),
// OpenCode (straight at the endpoint, in its own protocol) and Muse Code (whose provider speaks Responses, which the
// translator serves for an OpenAI-protocol endpoint); the owner's own key, so no vendor terms. The free trial is the
// exception, fixed to Claude Code: its one model id is the translator's, its disclosure is that loop's, and its pool
// refuses a replayed tool call without its own reasoning signature. `pi` runs on its own RPC runtime, and any other id
// is an installed ACP agent's own.
const ENDPOINT_LOOPS: ProviderLoops = {
    default: "claude-code",
    offered: {
        "claude-code": { capabilities: CLAUDE_CODE },
        codex: { capabilities: CODEX },
        opencode: { capabilities: OPENCODE },
        muse: { capabilities: MUSE },
    },
};
const TRIAL_LOOPS: ProviderLoops = { default: "claude-code", offered: { "claude-code": { capabilities: CLAUDE_CODE } } };
const PI_LOOPS: ProviderLoops = { default: "pi", offered: { pi: { capabilities: PI } } };
const ACP_LOOPS: ProviderLoops = { default: "vendor", offered: { vendor: { capabilities: ACP } } };

// The loop table for any provider id: its spec row's, or the rule for an endpoint, Pi or an ACP agent.
export const providerLoops = (provider: AgentProvider): ProviderLoops => {
    const spec = providerSpec(provider);
    if (spec !== undefined) {
        return spec.loops;
    }
    if (isEndpointProvider(provider)) {
        return isTrialProvider(provider) ? TRIAL_LOOPS : ENDPOINT_LOOPS;
    }
    return provider === PI_PROVIDER ? PI_LOOPS : ACP_LOOPS;
};

const LOOP_ORDER: readonly AgentLoop[] = HARNESSES.flatMap((entry) => (entry.value === "native" ? [] : [entry.value]));

// The loops this provider offers, its default first and the rest in the wire enum's order.
export const loopsOf = (provider: AgentProvider): readonly AgentLoop[] => {
    const loops = providerLoops(provider);
    return [loops.default, ...LOOP_ORDER.filter((loop) => loop !== loops.default && loops.offered[loop] !== undefined)];
};

// The loop a turn actually runs on: `native` is the provider's default, an offered loop is itself, and a loop the
// provider does not offer (a composer setting left over from another provider) runs the default rather than refusing.
export const loopOf = (provider: AgentProvider, harness: AgentHarness): AgentLoop => {
    const loops = providerLoops(provider);
    return harness !== "native" && loops.offered[harness] !== undefined ? harness : loops.default;
};

// The one spelling of a harness on a turn: `native` wherever it resolves to the default loop, so a turn naming its
// provider's own loop outright and one naming none are recorded alike.
export const canonicalHarness = (provider: AgentProvider, harness: AgentHarness | undefined): AgentHarness => {
    if (harness === undefined) {
        return "native";
    }
    const loop = loopOf(provider, harness);
    return loop === providerLoops(provider).default ? "native" : loop;
};

// Whether the loop is a real choice for this provider; derived, so a provider offered a second loop gains the chips.
export const harnessChoosable = (provider: AgentProvider): boolean => loopsOf(provider).length > 1;

// What a chip or a pill calls the loop. `vendor` is the provider's own agent, so it takes the provider's name, unless
// the offer names the program (Grok Build, Kimi CLI) because the provider's name is on its other loops too.
export const loopLabel = (provider: AgentProvider, loop: AgentLoop): string =>
    providerLoops(provider).offered[loop]?.label ??
    (loop === "vendor" ? providerLabel(provider) : (HARNESSES.find((entry) => entry.value === loop)?.label ?? loop));

// The account-door variant the loop a turn runs on signs in under (LoopOffer.door), resolved as the turn is; undefined
// where it spends the provider's default credential.
export const loopDoor = (provider: AgentProvider, harness: AgentHarness): string | undefined =>
    providerLoops(provider).offered[loopOf(provider, harness)]?.door;

// The loops whose own sign-in the provider's account door holds beside its default one, in loop order.
export const loopDoors = (provider: AgentProvider): readonly { readonly loop: AgentLoop; readonly door: string }[] =>
    loopsOf(provider).flatMap((loop) => {
        const door = providerLoops(provider).offered[loop]?.door;
        return door === undefined ? [] : [{ loop, door }];
    });

// Whether one of the provider's own accounts can serve a turn on this loop: where any loop signs in through a door of its
// own, an account serves the loop whose door its variant names, and an account naming none serves the default
// credential's loops; elsewhere (Z.ai's estates are variants too) every account serves every loop.
export const accountServesLoop = (provider: AgentProvider, harness: AgentHarness, account: { readonly variant?: string | undefined }): boolean => {
    const doors = loopDoors(provider);
    if (doors.length === 0) {
        return true;
    }
    const own = doors.some((entry) => entry.door === account.variant) ? account.variant : undefined;
    return own === loopDoor(provider, harness);
};

// What (provider, harness) can do, resolved as the turn is (loopOf).
export const capabilitiesOf = (provider: AgentProvider, harness: AgentHarness): AgentCapabilities => {
    const loops = providerLoops(provider);
    // loopOf only answers an offered loop or the default, and a row's default is offered (provider-specs.test.ts).
    return (loops.offered[loopOf(provider, harness)] ?? loops.offered[loops.default])!.capabilities;
};

// Where the daemon's runtime health map files one pair's own answer, beside the runtime's (keyed by runtime alone): a
// loop hosting a provider not its own can be ready for one and not another (Codex signed in to ChatGPT, but no Grok
// sign-in on the translator for Grok on Codex). A reader asks the pair's key first and the runtime's after it.
export const pairHealthKey = (runtime: AgentCapabilities["runtime"], provider: AgentProvider): string => `${runtime}:${provider}`;

// What the provider's own terms say about the loop serving it, when they say anything worth a quiet note; undefined
// where the vendor sanctions it or nothing is on record. Resolved as the turn is: a loop the provider does not offer
// reads as the one it runs.
export const termsOf = (provider: AgentProvider, harness: AgentHarness): LoopTerms | undefined =>
    providerLoops(provider).offered[loopOf(provider, harness)]?.terms;

// Which permission modes a runtime can actually be put in. Under "plan" every other mode collapses onto the autonomous
// posture the runtime already runs, so offering them would be three names for two behaviours.
export const modesFor = (capabilities: AgentCapabilities): readonly PermissionMode[] =>
    capabilities.permissions === "modes" ? ["default", "plan", "bypassPermissions"] : ["plan", "bypassPermissions"];

// The mode a selection falls back to when the runtime can't hold it, the same shape as clampEffort: a provider switch
// must not leave the composer showing a posture nothing applies.
export const clampMode = (mode: PermissionMode, capabilities: AgentCapabilities): PermissionMode =>
    modesFor(capabilities).includes(mode) ? mode : "bypassPermissions";

// What each reach of `mcp` leaves out, said once per answer.
const MCP_LIMITS = {
    none: ["no MCP tools or plugins"],
    http: ["MCP servers only, none of the daemon's own tools, no plugins"],
    tools: ["no plugins"],
    full: [],
} as const satisfies Record<AgentCapabilities["mcp"], readonly string[]>;

// What this pair cannot do, phrased for the sender; empty means the full ceiling. `fastMode` is deliberately not
// disclosed here, since it also depends on the route and model; fastAllowed answers that instead.
export const limitationsOf = (capabilities: AgentCapabilities): string[] => [
    ...(capabilities.permissions === "plan" ? ["no per-tool approvals"] : []),
    ...(capabilities.questions ? [] : ["no clarifying questions"]),
    ...(capabilities.steering ? [] : ["no mid-turn steering"]),
    ...MCP_LIMITS[capabilities.mcp],
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
    ...(capabilities.secrets === "shell" ? ["secrets masked in shell output only, not in files the agent reads"] : []),
    ...(capabilities.secrets === "none" ? ["secrets reach the model unmasked"] : []),
    ...(capabilities.toolAllowlist ? [] : ["no tool lists: an automation limited to some tools won't run here"]),
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

// Every reasoning tier a catalog row's `efforts` may name, weakest first. One vocabulary for every provider, so the
// picker can label and order a ladder it has never seen; a provider spelling a rung its own way translates on the way
// in, at the adapter that read it.
export const EFFORT_TIERS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

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

// Fast speed needs the runtime to be able to ask and the model to publish the `fast` badge (absent badges read as
// false). The Claude Code loop also needs a first-party route, since it serves translated and non-Anthropic endpoints
// that refuse it; any other loop that can ask speaks to its own vendor, whose catalog is where the badge came from.
export const fastAllowed = (capabilities: AgentCapabilities, provider: AgentProvider, badges: readonly ModelBadge[] | undefined): boolean =>
    capabilities.fastMode && (capabilities.runtime !== "claude-code" || provider === "claude") && (badges ?? []).includes("fast");
