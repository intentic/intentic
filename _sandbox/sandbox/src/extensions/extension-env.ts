import { extensionIdOf } from "@intentic/extension-manifest";
import type { Services } from "../composition.js";
import { readAllExtensionSettings } from "./extension-settings.js";
import { enabledExtensions } from "./installed-extensions.js";

/* The agent-shell env vars installed extensions contribute: every `contributes.settings` entry with an `env` name whose stored value is set. */
export const extensionEnvOf = async (services: Services): Promise<Record<string, string>> => {
    const extensions = (await enabledExtensions(services)).toSorted((a, b) => a.id.localeCompare(b.id));
    // Rehydrated: a setting declared `secret` lives in the vault, and `env` exists precisely so such a value can
    // reach the agent's shell, so this read has to see through the split (extension-settings.ts).
    const stored = await readAllExtensionSettings(services.workspace.root, services.extensionSecretVault);
    const env: Record<string, string> = {};
    for (const extension of extensions) {
        const values = stored[extensionIdOf(extension.manifest)] ?? {};
        for (const setting of extension.manifest.contributes?.settings ?? []) {
            const value = setting.env === undefined ? undefined : values[setting.key];
            if (value === undefined || value === "" || setting.env === undefined) {
                continue;
            }
            if (env[setting.env] !== undefined) {
                services.logger.warn({ env: setting.env, id: extension.id }, "extension env var collision, last wins");
            }
            env[setting.env] = String(value);
        }
    }
    return env;
};
