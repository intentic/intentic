import type { SettingValue } from "@intentic/extension-api";
import { ExtensionSettingsSchema } from "@intentic/sandbox-contract";
import { type ShallowRef, shallowRef } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";

/* One shared per-extension settings store (keyed by the capability entry id), so the Sandbox hub's Extensions
 * tab and a running extension's api.settings read and write THE SAME reactive record — an edit in either place
 * notifies the other. Values persist daemon-side (.intentic/extension-settings.json); saves overwrite the whole
 * record, mirroring the sandbox-settings pattern. */

export interface ExtensionSettingsStore {
    // The non-secret values — undefined until the first load resolves. Secret values are NEVER held client-side
    // (the daemon strips them from reads); `secretsSet` names the secret keys that currently hold a value.
    readonly values: ShallowRef<Record<string, SettingValue> | undefined>;
    readonly secretsSet: ShallowRef<readonly string[]>;
    readonly load: () => Promise<void>;
    // Persist a partial update. The daemon merges: keys omitted here keep their stored value (so a secret the
    // user didn't touch is preserved), non-secret declared keys absent are cleared, an empty-string secret
    // clears it. Reloads afterwards so `values` re-strips any secret that rode in.
    readonly save: (patch: Record<string, SettingValue>) => Promise<void>;
}

const stores = new Map<string, ExtensionSettingsStore>();

export const extensionSettingsStore = (id: string): ExtensionSettingsStore => {
    const existing = stores.get(id);
    if (existing !== undefined) {
        return existing;
    }
    const values = shallowRef<Record<string, SettingValue> | undefined>(undefined);
    const secretsSet = shallowRef<readonly string[]>([]);
    const load = async (): Promise<void> => {
        const parsed = ExtensionSettingsSchema.parse(await sandboxJson(`/extensions/${encodeURIComponent(id)}/settings`));
        values.value = parsed.settings;
        secretsSet.value = parsed.secretsSet;
    };
    const store: ExtensionSettingsStore = {
        values,
        secretsSet,
        load,
        save: async (patch) => {
            await sandboxJson(`/extensions/${encodeURIComponent(id)}/settings`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ settings: patch }),
            });
            await load();
        },
    };
    stores.set(id, store);
    return store;
};
