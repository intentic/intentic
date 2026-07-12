import type { SettingValue } from "@intentic/extension-api";
import { ExtensionSettingsSchema } from "@intentic/sandbox-contract";
import { type ShallowRef, shallowRef } from "vue";
import { sandboxJson } from "../sandboxClient";

/* One shared per-extension settings store (keyed by the capability entry id), so the Sandbox hub's Extensions
 * tab and a running extension's api.settings read and write THE SAME reactive record — an edit in either place
 * notifies the other. Values persist daemon-side (.intentic/extension-settings.json); saves overwrite the whole
 * record, mirroring the sandbox-settings pattern. */

export interface ExtensionSettingsStore {
    // undefined until the first load resolves.
    readonly values: ShallowRef<Record<string, SettingValue> | undefined>;
    readonly load: () => Promise<void>;
    readonly save: (next: Record<string, SettingValue>) => Promise<void>;
}

const stores = new Map<string, ExtensionSettingsStore>();

export const extensionSettingsStore = (id: string): ExtensionSettingsStore => {
    const existing = stores.get(id);
    if (existing !== undefined) {
        return existing;
    }
    const values = shallowRef<Record<string, SettingValue> | undefined>(undefined);
    const store: ExtensionSettingsStore = {
        values,
        load: async () => {
            values.value = ExtensionSettingsSchema.parse(await sandboxJson(`/extensions/${encodeURIComponent(id)}/settings`)).settings;
        },
        save: async (next) => {
            await sandboxJson(`/extensions/${encodeURIComponent(id)}/settings`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ settings: next }),
            });
            values.value = next;
        },
    };
    stores.set(id, store);
    return store;
};
