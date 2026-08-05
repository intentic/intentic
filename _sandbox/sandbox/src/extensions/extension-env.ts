import { extensionIdOf } from "@intentic/extension-api";
import type { Services } from "../composition.js";
import { readAllExtensionSettings } from "./extension-settings.js";
import { enabledExtensions } from "./installed-extensions.js";

/* The agent-shell env vars installed extensions contribute: every `contributes.settings` entry with an `env`
 * name whose stored value is set. This is the extension twin of cliEnvOf — a connector's credential reaching
 * the agent's CLI tools — but declared by the extension's manifest. Extensions are singletons per
 * publisher.name (settings are keyed by it), so NO per-instance suffixing, unlike cliEnvOf. A cross-extension
 * env-name collision resolves deterministically (id-sorted, last wins) with a warn. Merged beside cliEnvOf in
 * streamAgent, so every agent runtime's shell sees it. */
export const extensionEnvOf = async (services: Services): Promise<Record<string, string>> => {
    const extensions = (await enabledExtensions(services)).toSorted((a, b) => a.id.localeCompare(b.id));
    const stored = await readAllExtensionSettings(services.workspace.root);
    const env: Record<string, string> = {};
    for (const extension of extensions) {
        const values = stored[extensionIdOf(extension.manifest)] ?? {};
        for (const setting of extension.manifest.contributes?.settings ?? []) {
            const value = setting.env === undefined ? undefined : values[setting.key];
            if (value === undefined || value === "" || setting.env === undefined) {
                continue;
            }
            if (env[setting.env] !== undefined) {
                services.logger.warn({ env: setting.env, id: extension.id }, "extension env var collision — last wins");
            }
            env[setting.env] = String(value);
        }
    }
    return env;
};
