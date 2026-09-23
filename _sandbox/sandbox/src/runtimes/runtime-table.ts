import { type AgentCapabilities, type AgentHarness, type AgentProvider, capabilitiesOf, NATIVE_PROVIDERS } from "@intentic/sandbox-contract";
import type { AgentAdapter } from "../agent/providers/adapter.js";
import type { ProviderModule } from "../agent/providers/provider-module.js";
import { ACP_ADAPTER, type AcpAdapterDeps } from "./acp/acp-adapter.js";
import { claudeProvider, type ClaudeProviderDeps } from "./claude/claude-provider.js";
import { codexProvider, type CodexProviderDeps } from "./codex/codex-provider.js";
import { cursorProvider, type CursorProviderDeps } from "./cursor/cursor-provider.js";
import { type GeminiAdapterDeps, geminiProvider } from "./gemini/gemini-provider.js";
import { grokProvider, type GrokProviderDeps } from "./grok/grok-provider.js";
import { kimiProvider, type KimiProviderDeps } from "./kimi/kimi-provider.js";
import { MINTED_PROVIDER_MODULES, type MintedProviderDeps } from "./minted/minted-provider.js";
import { PI_ADAPTER, type PiAdapterDeps } from "./pi/pi-adapter.js";

// Every native provider's module and every runtime's adapter, as the two tables composition wires into Services. The one
// file that imports every runtime directory, and nothing but composition and its own test imports its values (the
// seam reads only its deps types), so no reader of a table can sit on a path back into a runtime.

// Everything the provider modules and their adapters read of the daemon, each module's own deps together.
export type ProviderDeps = ClaudeProviderDeps &
    CodexProviderDeps &
    CursorProviderDeps &
    GrokProviderDeps &
    GeminiAdapterDeps &
    KimiProviderDeps &
    MintedProviderDeps;

// List order feeds the pack overlay hash and must stay stable across daemon versions.
export const PROVIDER_MODULES: readonly ProviderModule<ProviderDeps>[] = [
    claudeProvider,
    codexProvider,
    cursorProvider,
    grokProvider,
    geminiProvider,
    kimiProvider,
    // Minted providers are generated from the spec table, not listed here by hand.
    ...MINTED_PROVIDER_MODULES,
];

// Fails fast at init if a native provider has no module, instead of shipping an incomplete picker.
const ids = PROVIDER_MODULES.map((module) => module.id);
if (new Set(ids).size !== ids.length || NATIVE_PROVIDERS.some((provider) => !ids.includes(provider)) || ids.length !== NATIVE_PROVIDERS.length) {
    throw new Error(`provider registry drift: modules [${ids.join(", ")}] must be exactly the native providers [${NATIVE_PROVIDERS.join(", ")}]`);
}

// Everything any adapter reads: the provider modules' deps plus the two installed-capability runtimes'.
export type RuntimeDeps = ProviderDeps & AcpAdapterDeps & PiAdapterDeps;

type RuntimeAdapter = AgentAdapter<AgentCapabilities["runtime"], RuntimeDeps>;

// Runtime → adapter dispatch, keyed by runtime rather than provider, since that is what serves a turn: capabilitiesOf
// resolves which runtime a (provider, harness) pair uses. ACP and Pi serve installed capabilities, not native providers.
export interface RuntimeAdapters {
    // Total by construction: `runtime` is a closed union, and runtime-table.test.ts walks every pair and demands one.
    readonly for: (provider: AgentProvider, harness: AgentHarness) => RuntimeAdapter;
    // Every adapter, for the surfaces that iterate them (the health sweep, this table's own test).
    readonly all: readonly RuntimeAdapter[];
}

const ADAPTERS: readonly RuntimeAdapter[] = [...PROVIDER_MODULES.flatMap((module) => module.adapters), ACP_ADAPTER, PI_ADAPTER];
const BY_RUNTIME = new Map(ADAPTERS.map((adapter) => [adapter.runtime, adapter]));

export const RUNTIME_ADAPTERS: RuntimeAdapters = {
    for: (provider, harness) => BY_RUNTIME.get(capabilitiesOf(provider, harness).runtime) as RuntimeAdapter,
    all: ADAPTERS,
};
