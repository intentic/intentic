import type { AgentHarness, AgentProvider, NativeProvider } from "./schemas.js";

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
];

// An ACP provider's label is its capability's display name, which the web layers on top — the raw id is the
// static fallback.
export const providerLabel = (provider: AgentProvider): string => PROVIDERS.find((p) => p.value === provider)?.label ?? provider;

// The harness (agentic loop) a turn runs on, orthogonal to the provider. `native` = the provider's own runtime;
// `claude-code` = the Claude Code loop for any provider (codex/grok then route through the translator). Only
// surfaced for codex/grok — claude is always its own Claude Code loop. See AgentHarness in schemas.ts.
export const HARNESSES: readonly { label: string; value: AgentHarness }[] = [
    { label: "Native", value: "native" },
    { label: "Claude Code", value: "claude-code" },
];

// The STATIC floor of the model catalog; every native provider's real list is the daemon's live catalog
// (/claude/models · /codex/models · /grok/models — discovery with a persisted/seed floor, never empty), which
// consumers layer on top. Native codex/grok are empty here (nothing sensible to offer before the live load);
// Claude's stable tier aliases always resolve to the newest version of each tier, so they double as the
// pre-load fallback. UNDER the Claude Code harness a non-Claude provider routes through the translator, which
// needs a concrete id, so codex/grok return one.
export const modelsFor = (provider: AgentProvider, harness: AgentHarness): CatalogOption[] => {
    if (provider === "codex") {
        return harness === "claude-code" ? [{ label: "GPT-5 Codex", value: "gpt-5-codex" }] : [];
    }
    if (provider === "grok") {
        return harness === "claude-code" ? [{ label: "Grok 4", value: "grok-4" }] : [];
    }
    if (provider === "claude") {
        return [
            { label: "Opus", value: "opus" },
            { label: "Sonnet", value: "sonnet" },
            { label: "Haiku", value: "haiku" },
        ];
    }
    // ACP providers: the model is the agent's own concern (configured on the capability), nothing to pick.
    return [];
};
