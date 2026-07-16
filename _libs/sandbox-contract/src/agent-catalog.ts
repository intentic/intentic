import type { AgentHarness, AgentProvider } from "./schemas.js";

/* The provider / harness / model catalog every picker shares (the chat menu, the automations dialog) — pure
 * data keyed by the wire enums in schemas.ts, so the surfaces can't drift. Live state stays with the consumer
 * (native Grok's model list is the daemon's /grok/models catalog, layered on top of modelsFor by the web). */

export interface CatalogOption {
    readonly label: string;
    readonly value: string;
}

// The agent runtimes the daemon can serve; new conversations use the selection, open ones stay locked (the
// pill reflects the locked provider). The brand logo per provider is drawn by ProviderLogo (by value).
export const PROVIDERS: readonly { label: string; value: AgentProvider }[] = [
    { label: "Claude Code", value: "claude" },
    { label: "Codex", value: "codex" },
    { label: "Grok", value: "grok" },
];

export const providerLabel = (provider: AgentProvider): string => PROVIDERS.find((p) => p.value === provider)?.label ?? "Claude Code";

// The harness (agentic loop) a turn runs on, orthogonal to the provider. `native` = the provider's own runtime;
// `claude-code` = the Claude Code loop for any provider (codex/grok then route through the translator). Only
// surfaced for codex/grok — claude is always its own Claude Code loop. See AgentHarness in schemas.ts.
export const HARNESSES: readonly { label: string; value: AgentHarness }[] = [
    { label: "Native", value: "native" },
    { label: "Claude Code", value: "claude-code" },
];

// Available models per provider+harness; Opus is the Claude default. NATIVE Codex has no public model list and its
// ChatGPT-account auth rejects an explicitly-named model, so it uses the account default (empty value the turn
// omits). Native Grok is NOT here (its list loads live from the daemon's /grok/models catalog — consumers layer it
// on top). UNDER the Claude Code harness a non-Claude provider routes through the translator, which needs a
// concrete id, so codex/grok return one.
export const modelsFor = (provider: AgentProvider, harness: AgentHarness): CatalogOption[] => {
    if (provider === "codex") {
        return harness === "claude-code" ? [{ label: "GPT-5 Codex", value: "gpt-5-codex" }] : [{ label: "GPT-5 Codex", value: "" }];
    }
    if (provider === "grok") {
        return harness === "claude-code" ? [{ label: "Grok 4", value: "grok-4" }] : [];
    }
    return [
        { label: "Opus", value: "opus" },
        { label: "Sonnet", value: "sonnet" },
        { label: "Haiku", value: "haiku" },
    ];
};
