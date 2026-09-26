import { join } from "node:path";
import { extensionIdOf } from "@intentic/extension-manifest";
import type { Logger } from "pino";
import { extensionSecretsDocument, fileSecretVault, type SecretVault } from "../capabilities/credentials/secret-vault.js";
import type { Config } from "../env.config.js";
import { createExtensionBackend, type ExtensionBackend } from "./backend/backend-supervisor.js";
import { type SecretKeyResolver, vaultExtensionSettingSecrets } from "./extension-settings.js";
import { type ExtensionHost, installedExtensions } from "./installed-extensions.js";

// The extension backend host and the vault its secret settings live in.
export interface ExtensionsSlice {
    // Extension backend: one node process running every enabled extension's server, proxied under /x/<id>/.
    readonly extensionBackend: ExtensionBackend;
    // Same vault, one table over: extension settings declared secret:true; needs rehydrating at three call sites.
    readonly extensionSecretVault: SecretVault;
    // Settings twin of vaultManifestSecrets: the tracked settings file is agent-editable too.
    readonly vaultExtensionSettingSecrets: () => Promise<readonly string[]>;
}

export interface ExtensionsDeps {
    readonly config: Pick<Config, "sandbox">;
    readonly logger: Logger;
    readonly workspaceRoot: string;
    // The AI-provider credential root, beside which the settings vault sits.
    readonly authRoot: string;
    // The extensions as the backend host serves them: over the capability store turns read, trial endpoint and vaulted
    // credentials included.
    readonly served: ExtensionHost;
    // The same over the raw manifest, for reading which settings are declared secret, which never needs a credential.
    readonly declared: ExtensionHost;
}

// Builds the extensions slice.
export const createExtensionsSlice = ({ config, logger, workspaceRoot, authRoot, served, declared }: ExtensionsDeps): ExtensionsSlice => {
    // Extension-settings' own vault, keyed by publisher.name, not capability id, since the two ids can collide.
    const extensionSecretVault = fileSecretVault(extensionSecretsDocument, join(authRoot, extensionSecretsDocument.path));
    const settingSecretKeys = async (): Promise<SecretKeyResolver> => {
        const secretKeys = new Map<string, ReadonlySet<string>>(
            (await installedExtensions(declared)).map((extension) => [
                extensionIdOf(extension.manifest),
                new Set((extension.manifest.contributes?.settings ?? []).filter((setting) => setting.secret === true).map((setting) => setting.key)),
            ]),
        );
        return (extensionId) => secretKeys.get(extensionId) ?? new Set<string>();
    };
    const onUnvaultableSetting = (id: string, keys: readonly string[]): void =>
        logger.warn(`extension settings: "${id}" declares ${keys.join(", ")} secret but stores a non-string, left in the tracked settings file`);
    return {
        extensionBackend: createExtensionBackend(() => served, config.sandbox.port, logger),
        extensionSecretVault,
        vaultExtensionSettingSecrets: async () =>
            vaultExtensionSettingSecrets(workspaceRoot, extensionSecretVault, await settingSecretKeys(), onUnvaultableSetting),
    };
};
