import type { AgentTool } from "../agent/tools/agent-tools.js";
import type { composeEnvironment } from "../environment/environment.js";
import type { CapabilitiesStore, vaultManifestSecrets } from "./capabilities-store.js";
import type { DismissalsStore } from "./offers/dismissals-store.js";
import type { OpenAccountInput, openBrowserAccount } from "./open-account.js";

// The capability manifest as turns and routes read it, its vaulted secrets, and the tools every turn carries.
export interface CapabilitiesSlice {
    // Intent-declared internal MCP tools, constant for the sandbox; merged with mcp-kind capabilities each turn.
    readonly tools: readonly AgentTool[];
    // The unified capability manifest; reads carry the daemon's free-trial endpoint, never written to the file.
    readonly capabilities: CapabilitiesStore;
    // Moves any credential left in the readable manifest into the vault; the agent may edit the manifest anytime.
    readonly vaultManifestSecrets: () => Promise<readonly string[]>;
    // Recommendations the owner declined, so a 'no' survives the reload that would otherwise re-derive it.
    readonly capabilityDismissals: DismissalsStore;
    readonly openBrowserAccount: (input: OpenAccountInput) => Promise<string>;
    readonly composeEnvironment: () => Promise<string | undefined>;
}
