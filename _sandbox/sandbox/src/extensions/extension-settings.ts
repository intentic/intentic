import { join } from "node:path";
import { z } from "zod";
import type { SecretVault } from "../capabilities/credentials/secret-vault.js";
import { defineDocument } from "../store/evolution/documents.js";
import type { JsonFile } from "../store/json-file.js";
import { openDocument } from "../store/open-document.js";
import { stateRelPath } from "../state-paths.js";

// Per-extension settings (.intentic/config/extension-settings.json), keyed by the manifest id (publisher.name).
// Not the capability entry id, so values survive a remove/re-add; secret values live in the vault instead.
// Writes go to the vault first: the failure mode is an orphaned vault row, never a credential in the tracked file.

const ExtensionSettingsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
type SettingsFile = Record<string, z.infer<typeof ExtensionSettingsSchema>>;
export type ExtensionSettings = SettingsFile[string];

export const extensionSettingsDocument = defineDocument({
    path: stateRelPath(".intentic/config/extension-settings.json"),
    schema: ExtensionSettingsSchema,
    granularity: "record",
});

// A handle per call: every handle on one path shares its write queue (queueOnFile), so concurrent writes both land.
const settingsFile = (root: string): JsonFile<SettingsFile> =>
    openDocument(extensionSettingsDocument, join(root, extensionSettingsDocument.path), { fallback: () => ({}) });

// Which of an extension's keys hold a credential; passed in since enumerating extensions sits a layer above this file.
// An unknown id gets an empty set, leaving its values in the file: the safe answer since nothing declares them secret.
export type SecretKeyResolver = (extensionId: string) => ReadonlySet<string>;

// Vault values are strings only; a secret boolean or number is unvaultable, not silently kept in the file.
// Reported to the caller instead. Mirrors partitionSecretValues.
export const partitionSettingValues = (
    settings: ExtensionSettings,
    secretKeys: ReadonlySet<string>,
): { readonly values: Record<string, string>; readonly open: ExtensionSettings; readonly unvaultable: readonly string[] } => {
    const values: Record<string, string> = {};
    const open: ExtensionSettings = {};
    const unvaultable: string[] = [];
    for (const [key, value] of Object.entries(settings)) {
        if (!secretKeys.has(key)) {
            open[key] = value;
        } else if (typeof value === "string") {
            values[key] = value;
        } else {
            unvaultable.push(key);
            open[key] = value;
        }
    }
    return { values, open, unvaultable };
};

// The whole map: vault values merged over the tracked file, what every reader expects to receive.
export const readAllExtensionSettings = async (root: string, vault: SecretVault): Promise<SettingsFile> => {
    const [stored, vaulted] = await Promise.all([settingsFile(root).read(), vault.all()]);
    const ids = new Set([...Object.keys(stored), ...Object.keys(vaulted)]);
    // Vault spread last: a key in both resolves to the vault's value, matching what writers already wrote.
    return Object.fromEntries([...ids].map((id) => [id, { ...stored[id], ...vaulted[id] }]));
};

export const writeExtensionSettings = async (
    root: string,
    vault: SecretVault,
    extensionId: string,
    settings: ExtensionSettings,
    secretKeys: ReadonlySet<string>,
    onUnvaultable?: (id: string, keys: readonly string[]) => void,
): Promise<void> => {
    const { values, open, unvaultable } = partitionSettingValues(settings, secretKeys);
    if (unvaultable.length > 0) {
        onUnvaultable?.(extensionId, unvaultable);
    }
    await vault.set(extensionId, values);
    await settingsFile(root).update((all) => ({ ...all, [extensionId]: open }));
};

// Drops one extension's values from both halves. The vault goes first for the same reason writes do: the survivable
// failure is a tracked file still naming keys, never a credential left in the vault for an extension that is gone.
export const forgetExtensionSettings = async (root: string, vault: SecretVault, extensionId: string): Promise<void> => {
    await vault.remove(extensionId);
    await settingsFile(root).update((all) => {
        if (!(extensionId in all)) {
            // By reference, so jsonFile skips the write when there is nothing to drop.
            return all;
        }
        const { [extensionId]: _dropped, ...rest } = all;
        return rest;
    });
};

// Sweeps values that should be vaulted but are not yet (other tools, an import, or a newly declared secret).
// Runs before the tracked file is committed; entries already clean are left untouched to avoid churn.
export const vaultExtensionSettingSecrets = async (
    root: string,
    vault: SecretVault,
    secretKeysOf: SecretKeyResolver,
    onUnvaultable?: (id: string, keys: readonly string[]) => void,
): Promise<readonly string[]> => {
    // Reads the raw file, not the rehydrated merge, since it must see which values are still unvaulted.
    const stored = await settingsFile(root).read();
    const moved: string[] = [];
    for (const [extensionId, settings] of Object.entries(stored)) {
        const secretKeys = secretKeysOf(extensionId);
        const { values, unvaultable } = partitionSettingValues(settings, secretKeys);
        // Reported separately; writing an unvaultable value back would only churn the file for no reason.
        if (unvaultable.length > 0) {
            onUnvaultable?.(extensionId, unvaultable);
        }
        if (Object.keys(values).length === 0) {
            continue;
        }
        // Vault wins on a shared key; the file's copy could swap out a credential still in use.
        const merged = { ...settings, ...(await vault.get(extensionId)) };
        await writeExtensionSettings(root, vault, extensionId, merged, secretKeys);
        moved.push(extensionId);
    }
    return moved;
};
