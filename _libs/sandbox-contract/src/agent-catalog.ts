import type { AgentHarness, AgentProvider, Model, NativeProvider } from "./schemas.js";

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
    { label: "Gemini", value: "gemini" },
];

// An ACP provider's label is its capability's display name, which the web layers on top — the raw id is the
// static fallback.
export const providerLabel = (provider: AgentProvider): string => PROVIDERS.find((p) => p.value === provider)?.label ?? provider;

// The harness (agentic loop) a turn runs on, orthogonal to the provider. `native` = the provider's own runtime;
// `claude-code` = the Claude Code loop for any provider (codex/grok then route through the translator). Only
// surfaced for codex/grok — claude is always its own Claude Code loop, and kimi/gemini have no native runtime
// to switch to (both only exist under this harness). See AgentHarness in schemas.ts.
export const HARNESSES: readonly { label: string; value: AgentHarness }[] = [
    { label: "Native", value: "native" },
    { label: "Claude Code", value: "claude-code" },
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
// category). Every point where a selection can land on an invalid pair — restore from storage, provider switch,
// thinking toggle, the picker's own option list — runs the pair through here, so the combination is unreachable
// rather than merely discouraged.
export const effortAllowed = (effort: string, provider: AgentProvider, thinking: boolean): boolean =>
    effort !== "max" || (provider === "claude" && thinking);

// The tier a selection falls back to when effortAllowed rejects it — one rung down from 'max', the top of every
// scale that excludes it.
export const clampEffort = (effort: string, provider: AgentProvider, thinking: boolean): string =>
    effortAllowed(effort, provider, thinking) ? effort : "xhigh";
