import { type AgentHarness, type AgentProvider, type Model, NATIVE_PROVIDERS, type NativeProvider, type PermissionMode } from "./schemas.js";

/* The provider / harness / model catalog every picker shares (the chat menu, the automations dialog) — pure
 * data keyed by the wire vocabulary in schemas.ts, so the surfaces can't drift. Live state stays with the
 * consumer (native Grok's model list is the daemon's /grok/models catalog, layered on top of modelsFor by the
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

// An ACP provider carries its own credentials — installed means runnable — so it has no access requirement at
// all; `undefined` is that state, and every surface reads it as "nothing to connect".
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
 * Four runtimes serve turns behind one seam (AgentRequest in, AgentEvent frames out): the Claude Code Agent SDK
 * loop, Codex's exec surface, OpenCode, and any ACP agent. They do NOT do the same things, and for a long time
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
    readonly runtime: "claude-code" | "codex" | "opencode" | "acp";
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
    isolation: "namespace",
    commands: true,
    terminals: true,
    recovery: true,
};

// Codex's exec surface: item-level events, no approval channel, no MCP seam through the SDK constructor we use.
// Reasoning effort IS forwarded (modelReasoningEffort). `codex app-server` is the upgrade path for the first two.
const CODEX: AgentCapabilities = {
    runtime: "codex",
    steering: false,
    permissions: "plan",
    questions: false,
    mcp: "none",
    effort: true,
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
    isolation: "cwd",
    commands: true,
    terminals: true,
    recovery: false,
};

// The pair → its record. An id that names no native provider is an installed `agent`-kind capability, served
// over ACP.
export const capabilitiesOf = (provider: AgentProvider, harness: AgentHarness): AgentCapabilities => {
    if (provider === "codex") {
        return harness === "claude-code" ? CLAUDE_CODE : CODEX;
    }
    if (provider === "grok") {
        return harness === "claude-code" ? CLAUDE_CODE : OPENCODE;
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

// What this pair does NOT do, phrased for the person about to send a message to it — the honest half of the
// picker, and the reason the record carries axes the daemon itself never branches on. Empty ⇒ the full ceiling.
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
// catalog (/claude/models · /codex/models · /grok/models — discovery with a persisted/seed floor, never empty),
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
