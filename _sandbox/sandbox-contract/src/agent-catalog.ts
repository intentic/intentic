import {
    type AgentHarness,
    type AgentProvider,
    type Model,
    type ModelBadge,
    NATIVE_PROVIDERS,
    type NativeProvider,
    type PermissionMode,
} from "./schemas.js";

/* The provider / harness / model catalog every picker shares (the chat menu, the automations dialog) — pure
 * data keyed by the wire vocabulary in schemas.ts, so the surfaces can't drift. Live state stays with the
 * consumer (native Grok's model list is the daemon's own catalog for it, layered on top of modelsFor by the
 * web; ACP providers are merged in from the installed `agent` capabilities). */

export interface CatalogOption {
    readonly label: string;
    readonly value: string;
}

// The NATIVE agent runtimes; ACP providers are appended by the consumer from the installed capabilities.
// New conversations use the selection, open ones stay locked (the pill reflects the locked provider). The
// brand logo per provider is drawn by ProviderLogo (by value).
export const PROVIDERS: readonly { label: string; value: NativeProvider }[] = [
    { label: "Claude Code", value: "claude" },
    { label: "Codex", value: "codex" },
    { label: "Grok", value: "grok" },
    { label: "Kimi Code", value: "kimi" },
    // Labelled for the ACCOUNT, not the model family: the `gemini` id names one channel — Google's Antigravity —
    // and that channel vends Claude and GPT-OSS models alongside Gemini's own (see gemini-models.ts). A section
    // headed "Gemini" holding Claude Opus would be a lie; "Google" is what the whole list has in common.
    { label: "Google", value: "gemini" },
];

// What it COSTS to unlock a provider, and what the user connects to do it — the axis the picker groups on, since
// "can this row actually run" is the first thing a model list has to answer. `free` is not a courtesy tier: the
// Google channel serves its models on an ordinary Google sign-in, at no subscription, which is the single most
// useful thing this catalog can tell a user who has connected nothing yet.
export type AccessKind = "free" | "subscription" | "key";

export interface ProviderAccess {
    readonly kind: AccessKind;
    // What the user connects, named the way its vendor names it — this is the noun every connect prompt uses.
    readonly requirement: string;
    // What connecting it lets them run, for the connect gate's one-line pitch.
    readonly runs: string;
}

export const PROVIDER_ACCESS: Record<NativeProvider, ProviderAccess> = {
    claude: { kind: "subscription", requirement: "Claude subscription", runs: "Claude Code" },
    codex: { kind: "subscription", requirement: "ChatGPT subscription", runs: "Codex" },
    grok: { kind: "subscription", requirement: "SuperGrok subscription", runs: "Grok" },
    kimi: { kind: "subscription", requirement: "Kimi Code subscription", runs: "Kimi Code" },
    gemini: { kind: "free", requirement: "Google sign-in", runs: "Gemini, Claude and GPT-OSS under Claude Code" },
};

/* THE PROVIDERS THAT COST NOTHING — derived from the table above rather than named a second time, and read by
 * every surface that LEADS with a free option instead of merely labelling one.
 *
 * The distinction is worth the export. `accessBadge` answers "what does this row cost" for a row the user is
 * already looking at; this answers "which row should a user who has connected nothing be shown FIRST", which is
 * the connect gate's whole job. Ranking the one free channel fifth among five equal buttons is how a user with
 * no subscription concluded the product needed one. Deriving the list keeps that promotion honest: a channel
 * that stops being free stops being promoted, from one edit to PROVIDER_ACCESS. */
export const FREE_PROVIDERS: readonly NativeProvider[] = NATIVE_PROVIDERS.filter((provider) => PROVIDER_ACCESS[provider].kind === "free");
export const isFreeProvider = (provider: AgentProvider): boolean => FREE_PROVIDERS.includes(provider as NativeProvider);

/* WHOSE ALLOWANCE A TURN ON THIS PROVIDER SPENDS, as the subject of a sentence — a third naming of the same
 * five ids, and the third is not redundancy. PROVIDERS names the RUNTIME the user picks ("Claude Code", "Kimi
 * Code") and PROVIDER_ACCESS.requirement names the thing they CONNECT ("Claude subscription", "Google sign-in");
 * neither reads as English in "… usage limit reached", and neither is what a spent quota belongs to.
 *
 * The routed providers are why this can't be inferred from the harness: a `gemini` turn drives Claude Opus 4.6
 * through Google's Antigravity channel on a plain Google sign-in, so the quota that refuses it is Google's and
 * Anthropic has no part in it. Saying "Claude usage limit reached" there sends the user to check the wrong
 * account — and to a reset that is days out on a pool they never touched. */
export const PROVIDER_VENDOR: Record<NativeProvider, string> = {
    claude: "Claude",
    codex: "ChatGPT",
    grok: "xAI",
    kimi: "Kimi Code",
    gemini: "Google",
};

// What a turn on this provider costs at the MARGIN, ordering the same three kinds by the only question a
// helper spending the user's money on their behalf has to answer: free is free; a subscription is already paid
// but has a quota the user watches; a key is metered, so every call is real money. Deliberately not folded into
// AccessKind's declaration order — a union's order is not a runtime fact, and this one is load-bearing.
export const ACCESS_COST: Record<AccessKind, number> = { free: 0, subscription: 1, key: 2 };

/* THE PROVIDER ID OF AN `endpoint` CAPABILITY — a model API the user pointed us at, native or not, near or far.
 *
 * Namespaced rather than bare (which is what ACP agents are) because the two kinds mint providers with OPPOSITE
 * ability records: an ACP agent brings its own loop and gets the documented ACP floor, while an endpoint is
 * driven BY the Claude Code loop and gets its full ceiling. capabilitiesOf answers that from the id alone, so
 * the prefix is what keeps it a pure function of (provider, harness) instead of a lookup against the installed
 * manifest — which the contract cannot see and the browser would have to pass in everywhere.
 *
 * A SLASH, never a colon: `${provider}:${model}` is the picker's own key shape, and quick-model.ts's parsePinned
 * splits a pinned selection on the FIRST colon. `endpoint:ollama:qwen3` would parse as provider "endpoint" with
 * model "ollama:qwen3" — a pin that silently resolves to nothing. The capability id (entryId) excludes both
 * characters, so `endpoint/<id>` stays unambiguous in either direction. */
/* THE FREE TRIAL'S ENDPOINT ID IS RESERVED, the way `pi` is — an `endpoint`-kind capability like any model API
 * the user configured, except that this one is provisioned by the DAEMON rather than added by a person, and it
 * points at intentic's own pool (see the sandbox's trial/ and the platform's /trial routes).
 *
 * Riding the endpoint kind is the entire reason the trial needed no new turn path, no new provider and no new
 * adapter: the translator already re-serves an OpenAI-compatible upstream to the Claude Code loop, so a trial
 * turn is an endpoint turn and everything downstream — catalog, picker, routing — works unchanged.
 *
 * What the reserved id buys is the part that must NOT look the same. A trial turn passes through intentic's
 * servers, which no other provider in this product does, and a user cannot consent to something they were not
 * told. So every surface that names a provider asks `isTrialProvider` and says so, and the id is here — beside
 * the vocabulary those surfaces already read — rather than spelled out in each of them. */
export const TRIAL_ENDPOINT_ID = "free-trial";
export const TRIAL_PROVIDER = "endpoint/free-trial";
export const isTrialProvider = (provider: AgentProvider): boolean => provider === TRIAL_PROVIDER;
// What the picker calls it, and the sentence the surfaces put underneath. One wording, so the composer's notice
// and the picker's row cannot end up describing different bargains.
export const TRIAL_LABEL = "Free trial";
export const TRIAL_NOTICE = "Trial messages pass through intentic's servers. Connect an account to chat directly.";

export const ENDPOINT_PROVIDER_PREFIX = "endpoint/";
export const endpointProvider = (id: string): AgentProvider => `${ENDPOINT_PROVIDER_PREFIX}${id}`;
export const isEndpointProvider = (provider: AgentProvider): boolean => provider.startsWith(ENDPOINT_PROVIDER_PREFIX);
// The capability id behind an endpoint provider; undefined when the provider is not one.
export const endpointIdOf = (provider: AgentProvider): string | undefined =>
    isEndpointProvider(provider) ? provider.slice(ENDPOINT_PROVIDER_PREFIX.length) : undefined;

// An ACP provider carries its own credentials — installed means runnable — so it has no access requirement at
// all; `undefined` is that state, and every surface reads it as "nothing to connect". An endpoint is the same
// answer for a different reason: its credential (if it even needs one) was configured with the endpoint itself,
// so there is likewise nothing left to connect. What a turn on it COSTS is deliberately not claimed here — a
// self-hosted model on the user's own GPU and a metered gateway key are the same shape to us, and inventing an
// AccessKind for them would have the picker assert a price the daemon has no way to know.
export const accessFor = (provider: AgentProvider): ProviderAccess | undefined => PROVIDER_ACCESS[provider as NativeProvider];

// An ACP provider's label is its capability's display name, which the web layers on top — the raw id is the
// static fallback.
export const providerLabel = (provider: AgentProvider): string => PROVIDERS.find((p) => p.value === provider)?.label ?? provider;

/* Whether a plan-limit reading for this provider is OBTAINABLE at all — one fact, on the wire, because both
 * halves need it and they need the same answer. The daemon reads it to decide what to even ask upstream for
 * (usage/translator-usage.ts); the browser reads it to say WHY an account shows no meter, which is the
 * difference between "this plan publishes nothing" and "we haven't measured yet" — two states that look
 * identical as a blank row and mean opposite things.
 *
 * Four can be read, by two mechanisms that stop at the daemon's readers: Claude's rides its own turn (the
 * OAuth usage endpoint, agent.ts), ChatGPT's, Google's and Kimi's are pulled through the translator's
 * credential-scoped api-call. Kimi's endpoint is the platform's own `/coding/v1/usages`, which the Kimi Code
 * subscription's OAuth token reads directly — the bundled translator does not route it, but it does not have
 * to: the api-call substitutes that token server-side like it does for the other two.
 *
 * Grok is the one absence, because xAI's usable billing data needs a subject id CLIProxyAPI keeps out of its
 * auth-file listing, and the fallback probe spends a token to answer. Adding it is adding a reader and its name
 * here, and nothing else. */
export const PLAN_LIMIT_PROVIDERS: readonly NativeProvider[] = ["claude", "codex", "gemini", "kimi"];
export const reportsPlanLimits = (provider: AgentProvider): boolean => PLAN_LIMIT_PROVIDERS.includes(provider as NativeProvider);

// The harness (agentic loop) a turn runs on, orthogonal to the provider. `native` = the provider's own runtime;
// `claude-code` = the Claude Code loop for any provider (codex/grok then route through the translator). Only
// surfaced for codex/grok — claude is always its own Claude Code loop, and kimi/gemini have no native runtime
// to switch to (both only exist under this harness). See AgentHarness in schemas.ts.
export const HARNESSES: readonly { label: string; value: AgentHarness }[] = [
    { label: "Native", value: "native" },
    { label: "Claude Code", value: "claude-code" },
];

/* WHAT A PROVIDER/HARNESS PAIR CAN ACTUALLY DO — one declaration, read by both sides of the wire.
 *
 * Five runtimes serve turns behind one seam (AgentRequest in, AgentEvent frames out): the Claude Code Agent SDK
 * loop, Codex app-server, OpenCode, any ACP agent, and Pi's RPC surface. They do NOT do the same things, and for a long time
 * the only thing that said so was a comment inside each adapter — "Ignores the Claude-only request fields" —
 * which no surface above it could read. So the composer offered "Ask before each file edit" on a runtime whose
 * every tool call is pre-approved, and offered a reasoning-effort scale to a runtime that drops the field.
 *
 * A capability is listed here only if something READS it: the daemon gates a seam on it, the composer hides or
 * clamps a control by it, or `limitationsOf` tells the user about it. That is the whole point — an ability the
 * matrix claims and nothing consults is how the drift started.
 *
 * Adding a provider is a row here, not a hunt for literals; agent-catalog.test.ts walks PROVIDERS × HARNESSES
 * and demands one, so a pair can never be silently absent. */
export interface AgentCapabilities {
    // Which agentic loop actually serves the turn — the question "is the harness `claude-code`" only looks like.
    // Claude is always its own Claude Code loop, and kimi/gemini have no native runtime at all (both are
    // re-served through the translator), so all three run it whatever harness the client sent; only codex/grok
    // have a native runtime to switch away from. Names the session store a finished conversation's transcript is
    // backfilled from, too.
    readonly runtime: "claude-code" | "codex" | "opencode" | "acp" | "pi";
    // Mid-turn injection (the SteeringQueue behind /agent/steer). Needs the SDK's streaming-input mode.
    readonly steering: boolean;
    // How much of the permission-mode axis the runtime honours. "modes" = every PermissionMode, with per-tool
    // permission cards and `mode` frames when the agent moves itself; "plan" = propose-then-approve or run, and
    // nothing in between — the container is the isolation boundary and every tool call is pre-approved.
    readonly permissions: "modes" | "plan";
    // Can stop mid-turn and ask the user a multiple-choice question (`question` frames).
    readonly questions: boolean;
    // Which of the turn's tools reach the agent. "full" = http MCP tools + in-process SDK servers + plugin
    // checkouts + the browser servers; "http" = the http MCP tools alone, and only if the agent advertises http
    // MCP support; "none" = the runtime has no seam for them at all.
    readonly mcp: "full" | "http" | "none";
    // Reasoning-effort selection is forwarded to the model.
    readonly effort: boolean;
    /* The runtime can serve a turn at fast speed when asked (AgentTurn.fast). A statement about the LOOP, not
     * about the route: the Claude Code loop knows how to ask for it, which is why every provider this record
     * hands the loop to reads true here — including the ones served through the translator, whose turns the
     * harness will then refuse fast mode for because a translator endpoint is not first-party. That second
     * question is answered where the endpoint is decided (planHarnessTurn), because it is a fact about the
     * CREDENTIAL rather than about the runtime, and this record is a pure function of (provider, harness). */
    readonly fastMode: boolean;
    // How an isolated conversation's worktree is enforced. "namespace" = the worktree IS /work inside the turn's
    // mount namespace (with the tool-input rewrite as the fallback when the container can't build one); "cwd" =
    // the turn is merely cwd'd into the worktree, so an absolute /work path still reaches the shared checkout —
    // which is why those turns are told where their tree is (turn-preamble.ts).
    readonly isolation: "namespace" | "cwd";
    // Publishes its slash commands (`commands` frames) for the composer's `/` popover.
    readonly commands: boolean;
    // Runs its shell in a tmux session the terminal panel can attach to (`terminal` frames).
    readonly terminals: boolean;
    // Fails with the coded frames the daemon's auto-resume keys off (rate_limit, provider-outage), so a turn the
    // provider killed is re-run once the breaker says the provider is back (turn-resume.ts).
    readonly recovery: boolean;
}

// The Claude Code Agent SDK loop — the ceiling every other runtime is measured against, and the only one that
// owns the whole request: permission callbacks, the ask tool, plugins, hooks, and the spawn seam a mount
// namespace needs.
const CLAUDE_CODE: AgentCapabilities = {
    runtime: "claude-code",
    steering: true,
    permissions: "modes",
    questions: true,
    mcp: "full",
    effort: true,
    fastMode: true,
    isolation: "namespace",
    commands: true,
    terminals: true,
    recovery: true,
};

// Codex app-server: item-level events plus richer request/MCP channels. This client deliberately declines
// server-initiated approvals and has not connected questions or MCP to Intentic's policy seams, so only the
// item stream and reasoning effort are claimed here.
const CODEX: AgentCapabilities = {
    runtime: "codex",
    steering: false,
    permissions: "plan",
    questions: false,
    mcp: "none",
    effort: true,
    fastMode: false,
    isolation: "cwd",
    commands: false,
    terminals: false,
    recovery: false,
};

// OpenCode (the Grok runtime): its own agentic loop, its own tools, allow-all permissions. It takes a model id
// and a prompt — no effort scale, no tools of ours, no command list.
const OPENCODE: AgentCapabilities = {
    runtime: "opencode",
    steering: false,
    permissions: "plan",
    questions: false,
    mcp: "none",
    effort: false,
    fastMode: false,
    isolation: "cwd",
    commands: false,
    terminals: false,
    recovery: false,
};

// Any agent speaking the Agent Client Protocol: a documented floor rather than the native ceiling. It publishes
// commands, runs its terminals in the conversation's tmux session, and takes our http MCP tools when it says it
// can — but it owns its own model, effort and permission posture.
const ACP: AgentCapabilities = {
    runtime: "acp",
    steering: false,
    permissions: "plan",
    questions: false,
    mcp: "http",
    effort: false,
    fastMode: false,
    isolation: "cwd",
    commands: true,
    terminals: true,
    recovery: false,
};

/* THE PI CAPABILITY ID IS RESERVED, the same way the five native ids are: an `agent`-kind capability installed
 * under it is served over Pi's own RPC protocol rather than ACP — Pi closed ACP support deliberately (its RPC
 * mode is the embedding surface), and the two want different records. A bare id rather than a namespace like
 * `endpoint/`, because there is exactly one Pi runtime to name; capabilitiesOf still answers from the id alone,
 * which is what keeps it a pure function of (provider, harness). */
export const PI_PROVIDER = "pi";

// Pi driven over its RPC mode (`pi --mode rpc`, strict-LF JSONL over stdio): above the ACP floor and below the
// Claude Code ceiling. Its `steer` command is real mid-turn injection; `set_thinking_level` takes the effort
// tiers; `get_commands` publishes its extension/skill commands. It has no MCP seam (Pi's own extensions are its
// tool surface), no approval channel (plan is the shared two-phase emulation), and runs bash in-process — no
// tmux session for the terminal panel to attach to.
const PI: AgentCapabilities = {
    runtime: "pi",
    steering: true,
    permissions: "plan",
    questions: false,
    mcp: "none",
    effort: true,
    fastMode: false,
    isolation: "cwd",
    commands: true,
    terminals: false,
    recovery: false,
};

// The pair → its record. An `endpoint/<id>` provider is a model API the user configured, driven BY the Claude
// Code loop on either harness — so it gets that loop's full ceiling, which is the entire point of routing a
// model through it rather than adopting a second runtime. The reserved `pi` id is the Pi coding agent on its
// own RPC runtime (harness doesn't apply — Pi is its own loop, like ACP). Any other id that names no native
// provider is an installed `agent`-kind capability, served over ACP.
export const capabilitiesOf = (provider: AgentProvider, harness: AgentHarness): AgentCapabilities => {
    if (provider === "codex") {
        return harness === "claude-code" ? CLAUDE_CODE : CODEX;
    }
    if (provider === "grok") {
        return harness === "claude-code" ? CLAUDE_CODE : OPENCODE;
    }
    if (isEndpointProvider(provider)) {
        return CLAUDE_CODE;
    }
    if (provider === PI_PROVIDER) {
        return PI;
    }
    return (NATIVE_PROVIDERS as readonly string[]).includes(provider) ? CLAUDE_CODE : ACP;
};

// Which permission modes a runtime can actually be put in. Under "plan" every other mode collapses onto the
// autonomous posture the runtime already runs, so offering them would be offering four names for two behaviours.
export const modesFor = (capabilities: AgentCapabilities): readonly PermissionMode[] =>
    capabilities.permissions === "modes" ? ["default", "acceptEdits", "plan", "bypassPermissions"] : ["plan", "bypassPermissions"];

// The mode a selection falls back to when the runtime can't hold it — the same shape as clampEffort, and for the
// same reason: a provider switch must not leave the composer showing a posture nothing applies.
export const clampMode = (mode: PermissionMode, capabilities: AgentCapabilities): PermissionMode =>
    modesFor(capabilities).includes(mode) ? mode : "bypassPermissions";

/* What this pair does NOT do, phrased for the person about to send a message to it — the honest half of the
 * picker, and the reason the record carries axes the daemon itself never branches on. Empty ⇒ the full ceiling.
 *
 * `fastMode` is deliberately NOT disclosed here, and it is the one axis that can't be: every other axis is fully
 * determined by the record, while fast mode also depends on the route and the model. The record says true for
 * every provider the Claude Code loop serves — including the ones routed through the translator, which can never
 * go fast — so a sentence derived from it would stay silent for exactly the turns that most need to hear it.
 * fastAllowed answers the real question, and the `fast_mode` frame reports what the turn actually got. */
export const limitationsOf = (capabilities: AgentCapabilities): string[] => [
    ...(capabilities.permissions === "plan" ? ["no per-tool approvals"] : []),
    ...(capabilities.questions ? [] : ["no clarifying questions"]),
    ...(capabilities.steering ? [] : ["no mid-turn steering"]),
    ...(capabilities.mcp === "none" ? ["no MCP tools or plugins"] : capabilities.mcp === "http" ? ["MCP tools only — no plugins or browser"] : []),
    ...(capabilities.effort ? [] : ["no effort control"]),
    ...(capabilities.commands ? [] : ["no slash commands"]),
    ...(capabilities.terminals ? [] : ["no terminal panel"]),
    ...(capabilities.isolation === "namespace" ? [] : ["worktree by working directory only"]),
    ...(capabilities.recovery ? [] : ["no auto-resume after an outage"]),
];

// Claude's compile-time model floor, shared by the daemon's catalog (claude-models.ts — its last rung, reached
// only before either live source has ever answered) and by the web's pre-load list, so the two can't name
// different models. VERSIONED ids only, never the tier aliases (`opus`, `sonnet`) that used to sit here: an
// alias names no version, so a turn running on one leaves the user unable to say what answered them — and it
// lags a release besides, resolving to the previous version for as long as the CLI keeps pointing it there.
// Going stale costs nothing: every rung above replaces the whole list, and a selection the live catalog no
// longer offers is repointed to its default (loadProviderModels web-side, routedModel daemon-side).
export const CLAUDE_SEED_MODELS: readonly Model[] = [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

// The STATIC floor of the model catalog, harness-independent: every provider's real list is the daemon's live
// catalog (/providers/{provider}/models — discovery with a persisted/seed floor, never empty),
// which consumers layer on top. Codex/grok are empty here (nothing sensible to offer before the live load — and
// under the Claude Code harness they route through the translator, which serves the SAME subscription model ids
// as the native catalog, so the harness no longer changes the list).
export const modelsFor = (provider: AgentProvider): CatalogOption[] => {
    if (provider === "claude") {
        return CLAUDE_SEED_MODELS.map((model) => ({ label: model.label, value: model.id }));
    }
    // Codex/Grok/Kimi/Gemini (live catalog only) and ACP providers (the agent owns its model): nothing static.
    return [];
};

// Whether a reasoning-effort tier is actually sendable for this provider with this thinking setting. 'max' is
// the only constrained tier and it fails two ways: no non-Claude scale HAS it, and Claude's API rejects it
// outright when extended thinking is disabled ("effort 'max' is not supported when thinking is disabled on this
// model" — a 400 that kills the turn before the model sees it, surfacing only as the SDK's `unknown` error
// category). It is the one rule a MODEL's published tier list can't express — the daemon reports what a model
// accepts without knowing this turn's thinking setting — so the consumer that assembles the offered scale
// (effortsFor, web-side) filters through here, and the clamp over that scale makes the pair unreachable.
export const effortAllowed = (effort: string, provider: AgentProvider, thinking: boolean): boolean =>
    effort !== "max" || (provider === "claude" && thinking);

/* The tier to actually SEND, which is the same rule applied as a repair rather than as a filter.
 *
 * effortAllowed makes the pair unreachable in the picker, and the picker is not the only way a turn is
 * assembled: a route, an extension, a restored tab or a settings-pinned model can all name an effort that no
 * live scale filtered. One did — a session ran `max` with thinking off, and every server-side tool call in it
 * came back `400 output_config.effort 'max' is not supported when thinking is disabled`, which reads to the
 * model as "web search is broken" and cost it the answer it was sent to find.
 *
 * So the daemon repairs the pair at the last gate before the API, taking the API's own advice ("use effort
 * 'high' or below, or enable thinking") rather than reporting it. The TIER is the half that moves: thinking is
 * a deliberate per-turn choice that changes what the turn costs, and silently switching it on would answer a
 * 400 by spending the user's money. */
export const sendableEffort = (effort: string | undefined, thinking: boolean | undefined): string | undefined =>
    effort === "max" && thinking !== true ? "high" : effort;

/* WHETHER FAST SPEED CAN BE OFFERED for a provider/harness/model triple — the picker-side filter, the same
 * shape and the same reason as effortAllowed: the composer must not show a control that does nothing.
 *
 * Three conditions, each answering a different question, and all three are load-bearing:
 *
 *   - the RUNTIME has to know how to ask (capabilities.fastMode). Only the Claude Code loop does.
 *   - the ROUTE has to be first-party. Every non-Claude provider the Claude Code loop serves is served through
 *     the sandbox's translator, and the harness refuses fast mode on a non-Anthropic endpoint ("not_first_party")
 *     — so a `grok` turn on the claude-code harness reads true on the capability and still cannot go fast.
 *   - the MODEL has to publish it, which is the `fast` badge Anthropic's own catalog reports per model
 *     (claude-models.ts maps supportsFastMode onto it). Curating a list of ids here instead is what this repo
 *     deliberately does not do — a model that gains or loses fast mode moves the badge, and this follows.
 *
 * `badges` absent ⇒ false. That is the honest reading: a catalog row that published no capabilities said
 * nothing about fast mode, and the seed floor a picker shows before its first live load is exactly that row. */
export const fastAllowed = (capabilities: AgentCapabilities, provider: AgentProvider, badges: readonly ModelBadge[] | undefined): boolean =>
    capabilities.fastMode && provider === "claude" && (badges ?? []).includes("fast");
