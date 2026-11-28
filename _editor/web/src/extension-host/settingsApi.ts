import type { Disposable, IntenticApi } from "@intentic/extension-api";
import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import { watch } from "vue";
import { extensionSettingsStore } from "../features/extensions/useExtensionSettings";

export const extensionSettingsApi = (
    summary: ExtensionSummary,
    fromInventory: boolean,
    track: (disposable: Disposable) => Disposable,
): IntenticApi[`settings`] => {
    const declared = summary.manifest.contributes?.settings ?? [];
    const defaults = Object.fromEntries(declared.flatMap(({ key, default: value }) => (value === undefined ? [] : [[key, value] as const])));
    const keys = new Set(declared.map((setting) => setting.key));
    // An unlisted built-in uses manifest defaults even if another sandbox loaded the same extension's settings.
    const settings = fromInventory ? extensionSettingsStore(summary.id) : undefined;

    return {
        get: (key) => settings?.values.value?.[key] ?? defaults[key],
        set: async (key, value) => {
            if (!keys.has(key)) {
                throw new Error(`setting "${key}" is not declared in the manifest's contributes.settings`);
            }
            if (settings === undefined) {
                throw new Error(`setting "${key}" cannot be saved until the sandbox lists extension "${summary.id}"`);
            }
            await settings.save({ ...settings.values.value, [key]: value });
        },
        onDidChange: (listener) => {
            if (settings === undefined) {
                return { dispose: () => {} };
            }
            let previous = settings.values.value ?? {};
            const stop = watch(settings.values, (next) => {
                const current = next ?? {};
                const before = previous;
                previous = current;
                for (const key of new Set([...Object.keys(before), ...Object.keys(current)])) {
                    if (before[key] !== current[key]) {
                        listener(key);
                    }
                }
            });
            return track({ dispose: () => stop() });
        },
    };
};
