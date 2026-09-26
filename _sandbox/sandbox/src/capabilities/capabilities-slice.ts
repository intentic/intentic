import { join } from "node:path";
import type { Logger } from "pino";
import type { AgentTool } from "../agent/tools/agent-tools.js";
import type { Services } from "../composition.js";
import type { Config } from "../env.config.js";
import { composeEnvironment } from "../environment/environment.js";
import type { ExtensionHost } from "../extensions/installed-extensions.js";
import { readWorkspaceFile } from "../workspace/files/workspace-files.js";
import { capabilitiesDocument, type CapabilitiesStore, fileCapabilitiesStore, vaultManifestSecrets, withSecretVault } from "./capabilities-store.js";
import { contributionRegistry, invalidatingContributions, type ResolvedContribution } from "./contributions.js";
import { capabilitySecretsDocument, fileSecretVault, type SecretVault } from "./credentials/secret-vault.js";
import { dismissalsDocument, type DismissalsStore, fileDismissalsStore } from "./offers/dismissals-store.js";
import { openBrowserAccount, type OpenAccountInput } from "./open-account.js";

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

export interface CapabilitiesDeps {
    readonly config: Config;
    readonly logger: Logger;
    readonly workspaceRoot: string;
    // The AI-provider credential root, where the credential vault sits beside the logins.
    readonly authRoot: string;
    // What lays over the vaulted store, never into it: the free trial's endpoint (trial/trial-endpoint.ts), passed in
    // since importing it here would close capabilities -> trial -> system -> capabilities.
    readonly overlay: (store: CapabilitiesStore) => CapabilitiesStore;
    // Filing a browser account and recomposing the environment overlay each reach most of the daemon, so they read the
    // finished services per call (composition.ts).
    readonly whole: () => Services;
}

// The member agent/ builds, which composition.ts adds: importing it here would close capabilities -> agent -> capabilities.
export type AgentToolsMember = "tools";

// What else is built from the raw manifest rather than the decorated store turns read: the secret registry names the
// vault, the invariants and the extension settings enumerate from the raw manifest, which never reads a credential.
export interface CapabilitiesParts {
    readonly slice: Omit<CapabilitiesSlice, AgentToolsMember>;
    readonly manifest: CapabilitiesStore;
    readonly secretVault: SecretVault;
    readonly connectors: () => Promise<ReadonlyMap<string, ResolvedContribution>>;
    // The extension host over the raw manifest, for whatever enumerates installed extensions without a credential.
    readonly manifestHost: ExtensionHost;
}

// Builds the capabilities slice and the parts of it other slices are built from.
export const createCapabilitiesSlice = ({ config, logger, workspaceRoot, authRoot, overlay, whole }: CapabilitiesDeps): CapabilitiesParts => {
    // Every write moves the contribution inventory (contributions.ts), which enumerates installed extensions from here;
    // the file watcher would too, but only after a turn planned in between had read the old one.
    const manifest = invalidatingContributions(
        fileCapabilitiesStore(join(workspaceRoot, capabilitiesDocument.path), (id, reason) =>
            logger.warn(`capabilities: skipping unreadable entry "${id}" (${reason}), the rest of the manifest is unaffected`),
        ),
    );
    // Credential values, off /work, sited beside the AI-provider logins outside the file routes and search index.
    const secretVault = fileSecretVault(capabilitySecretsDocument, join(authRoot, capabilitySecretsDocument.path));
    const manifestHost: ExtensionHost = {
        workspace: { root: workspaceRoot },
        files: { read: readWorkspaceFile },
        capabilities: manifest,
        config: { extensionsDir: config.extensionsDir, historyRoot: config.historyRoot },
    };
    // Resolved against the raw manifest, not the vaulted store, since enumeration never reads a credential.
    const connectors = () => contributionRegistry(manifestHost);
    const onUnvaultable = (id: string, fields: readonly string[]): void =>
        logger.warn(
            `capabilities: "${id}" holds non-string credential field(s) ${fields.join(", ")}, left in the manifest, which the agent can read`,
        );
    const capabilities = overlay(withSecretVault(manifest, secretVault, connectors, onUnvaultable));
    return {
        manifest,
        secretVault,
        connectors,
        manifestHost,
        slice: {
            capabilities,
            vaultManifestSecrets: () => vaultManifestSecrets(manifest, secretVault, connectors, onUnvaultable),
            capabilityDismissals: fileDismissalsStore(join(workspaceRoot, dismissalsDocument.path)),
            openBrowserAccount: (input) => openBrowserAccount(whole(), input),
            composeEnvironment: () => composeEnvironment(whole()),
        },
    };
};
