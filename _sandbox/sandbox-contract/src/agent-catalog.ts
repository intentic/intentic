import { ACP, type AgentCapabilities, CLAUDE_CODE, PI } from "./agent-runtimes.js";
import { type NativeProvider, PROVIDER_SPECS, type ProviderAccess, providerSpec } from "./provider-specs.js";
import type { AgentHarness, AgentProvider, PermissionMode } from "./schemas/agent.js";
import type { Model, ModelBadge } from "./schemas/provider-oauth.js";

/* The provider / harness / model catalog every picker shares (the chat menu, the automations dialog), pure
 * data keyed by the wire vocabulary in schemas/agent.ts, so the surfaces can't drift. Live state stays with the
 * consumer (native Grok's model list is the daemon's own catalog for it, layered on top of modelsFor by the
 * web; ACP providers are merged in from the installed `agent` capabilities).
 *
 * NOTHING HERE IS A LIST OF PROVIDERS ANY MORE. Every table below is DERIVED from PROVIDER_SPECS, which is the
 * one row-per-provider table this package keeps (provider-specs.ts, and its header says why). What remains here
 * is the shape each surface wants that table in, plus the rules that are about something other than a provider
 * (the trial, the endpoint namespace, the effort and fast-mode gates). */

export interface CatalogOption {
    readonly label: string;
    readonly value: string;
}

// The NATIVE agent runtimes; ACP providers are appended by the consumer from the installed capabilities.
// New conversations use the selection, open ones stay locked (the pill reflects the locked provider). The
// brand logo per provider is drawn by ProviderLogo (by value). Order is the spec table's order.
export const PROVIDERS: readonly { label: string; value: NativeProvider }[] = PROVIDER_SPECS.map((spec) => ({
    label: spec.label,
    value: spec.id,
}));

// What it COSTS to unlock a provider, and what the user connects to do it, the axis the picker groups on, since
// "can this row actually run" is the first thing a model list has to answer. See ProviderAccess in
// provider-specs.ts for what `free` means here, and why it is not a courtesy tier.
export const PROVIDER_ACCESS: Record<NativeProvider, ProviderAccess> = Object.fromEntries(
    PROVIDER_SPECS.map((spec) => [spec.id, spec.access] as const),
) as Record<NativeProvider, ProviderAccess>;

/* THE PROVIDERS THAT COST NOTHING, read by every surface that LEADS with a free option instead of merely
 * labelling one.
 *
 * The distinction is worth the export. `accessBadge` answers "what does this row cost" for a row the user is
 * already looking at; this answers "which row should a user who has connected nothing be shown FIRST", which is
 * the connect gate's whole job. Ranking the one free channel last among equal buttons is how a user with
 * no subscription concluded the product needed one. Deriving the list keeps that promotion honest: a channel
 * that stops being free stops being promoted, from one edit to its spec row. */
export const FREE_PROVIDERS: readonly NativeProvider[] = PROVIDER_SPECS.filter((spec) => spec.access.kind === "free").map((spec) => spec.id);
export const isFreeProvider = (provider: AgentProvider): boolean => FREE_PROVIDERS.includes(provider as NativeProvider);

// WHOSE ALLOWANCE A TURN ON THIS PROVIDER SPENDS, as the subject of a sentence. See ProviderSpec.vendor for why
// this is a third naming of the same ids rather than a duplicate of the label or the requirement.
export const PROVIDER_VENDOR: Record<NativeProvider, string> = Object.fromEntries(
    PROVIDER_SPECS.map((spec) => [spec.id, spec.vendor] as const),
) as Record<NativeProvider, string>;

/* THE PROVIDER ID OF AN `endpoint` CAPABILITY, a model API the user pointed us at, native or not, near or far.
 *
 * Namespaced rather than bare (which is what ACP agents are) because the two kinds mint providers with OPPOSITE
 * ability records: an ACP agent brings its own loop and gets the documented ACP floor, while an endpoint is
 * driven BY the Claude Code loop and gets its full ceiling. capabilitiesOf answers that from the id alone, so
 * the prefix is what keeps it a pure function of (provider, harness) instead of a lookup against the installed
 * manifest, which the contract cannot see and the browser would have to pass in everywhere.
 *
 * A SLASH, never a colon: `${provider}:${model}` is the picker's own key shape, and quick-model.ts's parsePinned
 * splits a pinned selection on the FIRST colon. `endpoint:ollama:qwen3` would parse as provider "endpoint" with
 * model "ollama:qwen3", a pin that silently resolves to nothing. The capability id (entryId) excludes both
 * characters, so `endpoint/<id>` stays unambiguous in either direction. */
/* THE FREE TRIAL'S ENDPOINT ID IS RESERVED, the way `pi` is, an `endpoint`-kind capability like any model API
 * the user configured, except that this one is provisioned by the DAEMON rather than added by a person, and it
 * points at intentic's own pool (see the sandbox's trial/ and the platform's /trial routes).
 *
 * Riding the endpoint kind is the entire reason the trial needed no new turn path, no new provider and no new
 * adapter: the translator already re-serves an OpenAI-compatible upstream to the Claude Code loop, so a trial
 * turn is an endpoint turn and everything downstream, catalog, picker, routing, works unchanged.
 *
 * What the reserved id buys is the part that must NOT look the same. A trial turn passes through intentic's
 * servers, which no other provider in this product does, and a user cannot consent to something they were not
 * told. So every surface that names a provider asks `isTrialProvider` and says so, and the id is here, beside
 * the vocabulary those surfaces already read, rather than spelled out in each of them. */
export const TRIAL_ENDPOINT_ID = "free-trial";
export const TRIAL_PROVIDER = "endpoint/free-trial";
export const isTrialProvider = (provider: AgentProvider): boolean => provider === TRIAL_PROVIDER;

/* THE ONLY MODEL THE TRIAL PUBLISHES, a synthetic id, not one of Google's, and that is the point.
 *
 * The trial used to publish whatever the upstream listed. Two things were wrong with that and neither could be
 * fixed by filtering harder. Google lists ~54 models on a fresh key and declares `generateContent` for many that
 * cannot serve an agent turn, deep-research, antigravity, gemma, robotics and computer-use previews all pass a
 * capability check and then fail the first message, so the picker was full of rows whose only outcome was an
 * error. And the list MOVED: the translator's routing table is written at boot and on capability edits, while
 * the picker re-reads the catalog every minute, so a model discovered in between was pickable and unroutable,
 * refused with "unknown provider for model".
 *
 * One id, never changing, ends both. There is nothing to filter because nothing is discovered, and the routing
 * table cannot drift from a list of one constant. WHICH real model answers is decided per message by the
 * platform, which is the only party that can see which of its keys still has quota on which model, the sandbox
 * cannot, and a user choosing blind between rows they know nothing about was never a choice worth offering. */
export const TRIAL_MODEL_ID = "auto";
// What the picker calls it, and the sentence the surfaces put underneath. One wording, so the composer's notice
// and the picker's row cannot end up describing different bargains.
export const TRIAL_LABEL = "Free trial";
export const TRIAL_NOTICE = "Trial messages pass through intentic. Connect an account to chat directly.";

export const ENDPOINT_PROVIDER_PREFIX = "endpoint/";
export const endpointProvider = (id: string): AgentProvider => `${ENDPOINT_PROVIDER_PREFIX}${id}`;
export const isEndpointProvider = (provider: AgentProvider): boolean => provider.startsWith(ENDPOINT_PROVIDER_PREFIX);
// The capability id behind an endpoint provider; undefined when the provider is not one.
export const endpointIdOf = (provider: AgentProvider): string | undefined =>
    isEndpointProvider(provider) ? provider.slice(ENDPOINT_PROVIDER_PREFIX.length) : undefined;

// An ACP provider carries its own credentials, installed means runnable, so it has no access requirement at
// all; `undefined` is that state, and every surface reads it as "nothing to connect". An endpoint is the same
// answer for a different reason: its credential (if it even needs one) was configured with the endpoint itself,
// so there is likewise nothing left to connect. What a turn on it COSTS is deliberately not claimed here, a
// self-hosted model on the user's own GPU and a metered gateway key are the same shape to us, and inventing an
// AccessKind for them would have the picker assert a price the daemon has no way to know.
export const accessFor = (provider: AgentProvider): ProviderAccess | undefined => providerSpec(provider)?.access;

// An ACP provider's label is its capability's display name, which the web layers on top, the raw id is the
// static fallback.
export const providerLabel = (provider: AgentProvider): string => providerSpec(provider)?.label ?? provider;

// Whether a plan-limit reading for this provider is OBTAINABLE at all. See ProviderSpec.planLimits for which
// four can be read, by which two mechanisms, and why the absences are absences rather than gaps.
export const PLAN_LIMIT_PROVIDERS: readonly NativeProvider[] = PROVIDER_SPECS.filter((spec) => spec.planLimits).map((spec) => spec.id);
export const reportsPlanLimits = (provider: AgentProvider): boolean => PLAN_LIMIT_PROVIDERS.includes(provider as NativeProvider);

// The harness (agentic loop) a turn runs on, orthogonal to the provider. `native` = the provider's own runtime;
// `claude-code` = the Claude Code loop for any provider (codex/grok then route through the translator).
// WHICH providers actually offer the choice is not a list any more: a spec whose two runtime records are the
// same one is a provider with nothing to choose, and every surface reads that rather than remembering the
// exceptions (Claude is always its own loop; kimi, meta and zai have no native runtime to switch to; and GEMINI
// IS THE MIRROR, it only exists under its native one, because Google refuses Claude Code's traffic outright).
// See AgentHarness in schemas/agent.ts.
export const HARNESSES: readonly { label: string; value: AgentHarness }[] = [
    { label: "Native", value: "native" },
    { label: "Claude Code", value: "claude-code" },
];

// Whether the harness axis is a real choice for this provider, or a switch whose two positions run the same
// loop. Derived, so a provider that gains a native runtime tomorrow gains the switch with it, and one that
// never had one never shows a control that does nothing.
export const harnessChoosable = (provider: AgentProvider): boolean => {
    const spec = providerSpec(provider);
    return spec !== undefined && spec.runtimes.native.runtime !== spec.runtimes.claudeCode.runtime;
};

/* THE PAIR → ITS RECORD. A native provider answers its spec row's two runtimes. An `endpoint/<id>` provider is
 * a model API the user configured, driven BY the Claude Code loop on either harness, so it gets that loop's
 * full ceiling, which is the entire point of routing a model through it rather than adopting a second runtime.
 * The reserved `pi` id is the Pi coding agent on its own RPC runtime (harness doesn't apply. Pi is its own
 * loop, like ACP). Any other id that names no native provider is an installed `agent`-kind capability, served
 * over ACP.
 *
 * The three providers whose spec names ONE record on both harnesses are answering the harness with a fact
 * rather than a preference, and each has its own reason, stated on its row: Kimi, Meta and Z.ai have no native
 * runtime at all; Google refuses Claude Code's traffic; Cursor has no route but its own SDK. Reading it off the
 * table is what makes those structural instead of a rule each surface has to remember. */
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

/* THE PI CAPABILITY ID IS RESERVED, the same way the native ids are: an `agent`-kind capability installed
 * under it is served over Pi's own RPC protocol rather than ACP. Pi closed ACP support deliberately (its RPC
 * mode is the embedding surface), and the two want different records. A bare id rather than a namespace like
 * `endpoint/`, because there is exactly one Pi runtime to name; capabilitiesOf still answers from the id alone,
 * which is what keeps it a pure function of (provider, harness). */
export const PI_PROVIDER = "pi";

// Which permission modes a runtime can actually be put in. Under "plan" every other mode collapses onto the
// autonomous posture the runtime already runs, so offering them would be offering four names for two behaviours.
export const modesFor = (capabilities: AgentCapabilities): readonly PermissionMode[] =>
    capabilities.permissions === "modes" ? ["default", "acceptEdits", "plan", "bypassPermissions"] : ["plan", "bypassPermissions"];

// The mode a selection falls back to when the runtime can't hold it, the same shape as clampEffort, and for the
// same reason: a provider switch must not leave the composer showing a posture nothing applies.
export const clampMode = (mode: PermissionMode, capabilities: AgentCapabilities): PermissionMode =>
    modesFor(capabilities).includes(mode) ? mode : "bypassPermissions";

/* What this pair does NOT do, phrased for the person about to send a message to it, the honest half of the
 * picker, and the reason the record carries axes the daemon itself never branches on. Empty ⇒ the full ceiling.
 *
 * `fastMode` is deliberately NOT disclosed here, and it is the one axis that can't be: every other axis is fully
 * determined by the record, while fast mode also depends on the route and the model. The record says true for
 * every provider the Claude Code loop serves, including the ones routed through the translator, which can never
 * go fast, so a sentence derived from it would stay silent for exactly the turns that most need to hear it.
 * fastAllowed answers the real question, and the `fast_mode` frame reports what the turn actually got. */
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

// Claude's compile-time model floor, shared by the daemon's catalog (claude-models.ts, its last rung, reached
// only before either live source has ever answered) and by the web's pre-load list, so the two can't name
// different models. VERSIONED ids only, never the tier aliases (`opus`, `sonnet`) that used to sit here: an
// alias names no version, so a turn running on one leaves the user unable to say what answered them, and it
// lags a release besides, resolving to the previous version for as long as the CLI keeps pointing it there.
// Going stale costs nothing: every rung above replaces the whole list, and a selection the live catalog no
// longer offers is repointed to its default (loadProviderModels web-side, routedModel daemon-side).
export const CLAUDE_SEED_MODELS: readonly Model[] = [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

// The STATIC floor of the model catalog, harness-independent: every provider's real list is the daemon's live
// catalog (/providers/{provider}/models, discovery with a persisted/seed floor, never empty),
// which consumers layer on top. Every provider but Claude is empty here (nothing sensible to offer before the
// live load, and under the Claude Code harness the routed ones serve the SAME subscription model ids as their
// native catalog, so the harness no longer changes the list).
export const modelsFor = (provider: AgentProvider): CatalogOption[] => {
    if (provider === "claude") {
        return CLAUDE_SEED_MODELS.map((model) => ({ label: model.label, value: model.id }));
    }
    // Every other native provider (live catalog only) and ACP providers (the agent owns its model): nothing
    // static. A keyed provider's floor is the daemon's, not the browser's: it is discovered from the vendor's
    // own /models with a seed behind it, and duplicating that seed here would be a second list to keep right.
    return [];
};

// Whether a reasoning-effort tier is actually sendable for this provider with this thinking setting. 'max' is
// the only constrained tier and it fails two ways: no non-Claude scale HAS it, and Claude's API rejects it
// outright when extended thinking is disabled ("effort 'max' is not supported when thinking is disabled on this
// model", a 400 that kills the turn before the model sees it, surfacing only as the SDK's `unknown` error
// category). It is the one rule a MODEL's published tier list can't express, the daemon reports what a model
// accepts without knowing this turn's thinking setting, so the consumer that assembles the offered scale
// (effortsFor, web-side) filters through here, and the clamp over that scale makes the pair unreachable.
export const effortAllowed = (effort: string, provider: AgentProvider, thinking: boolean): boolean =>
    effort !== "max" || (provider === "claude" && thinking);

/* The tier to actually SEND, which is the same rule applied as a repair rather than as a filter.
 *
 * effortAllowed makes the pair unreachable in the picker, and the picker is not the only way a turn is
 * assembled: a route, an extension, a restored tab or a settings-pinned model can all name an effort that no
 * live scale filtered. One did, a session ran `max` with thinking off, and every server-side tool call in it
 * came back `400 output_config.effort 'max' is not supported when thinking is disabled`, which reads to the
 * model as "web search is broken" and cost it the answer it was sent to find.
 *
 * So the daemon repairs the pair at the last gate before the API, taking the API's own advice ("use effort
 * 'high' or below, or enable thinking") rather than reporting it. The TIER is the half that moves: thinking is
 * a deliberate per-turn choice that changes what the turn costs, and silently switching it on would answer a
 * 400 by spending the user's money. */
export const sendableEffort = (effort: string | undefined, thinking: boolean | undefined): string | undefined =>
    effort === "max" && thinking !== true ? "high" : effort;

/* WHETHER FAST SPEED CAN BE OFFERED for a provider/harness/model triple, the picker-side filter, the same
 * shape and the same reason as effortAllowed: the composer must not show a control that does nothing.
 *
 * Three conditions, each answering a different question, and all three are required:
 *
 *   - the RUNTIME has to know how to ask (capabilities.fastMode). Only the Claude Code loop does.
 *   - the ROUTE has to be first-party. Every non-Claude provider the Claude Code loop serves is served through
 *     the sandbox's translator or pointed at the vendor's own endpoint, and the harness refuses fast mode on a
 *     non-Anthropic endpoint ("not_first_party"), so a `grok` turn on the claude-code harness reads true on the
 *     capability and still cannot go fast.
 *   - the MODEL has to publish it, which is the `fast` badge Anthropic's own catalog reports per model
 *     (claude-models.ts maps supportsFastMode onto it). Curating a list of ids here instead is what this repo
 *     deliberately does not do, a model that gains or loses fast mode moves the badge, and this follows.
 *
 * `badges` absent ⇒ false. That is the honest reading: a catalog row that published no capabilities said
 * nothing about fast mode, and the seed floor a picker shows before its first live load is exactly that row. */
export const fastAllowed = (capabilities: AgentCapabilities, provider: AgentProvider, badges: readonly ModelBadge[] | undefined): boolean =>
    capabilities.fastMode && provider === "claude" && (badges ?? []).includes("fast");
