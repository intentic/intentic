import type { SecretVault } from "../capabilities/credentials/secret-vault.js";
import type { ExtensionBackend } from "./backend/backend-supervisor.js";

// The extension backend host and the vault its secret settings live in.
export interface ExtensionsSlice {
    // Extension backend: one node process running every enabled extension's server, proxied under /x/<id>/.
    readonly extensionBackend: ExtensionBackend;
    // Same vault, one table over: extension settings declared secret:true; needs rehydrating at three call sites.
    readonly extensionSecretVault: SecretVault;
    // Settings twin of vaultManifestSecrets: the tracked settings file is agent-editable too.
    readonly vaultExtensionSettingSecrets: () => Promise<readonly string[]>;
}
