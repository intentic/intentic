import { z } from "zod";
import type { SecretVault } from "../capabilities/secret-vault.js";
import { type JsonFile, jsonFile } from "../store/json-file.js";
import { statePath } from "../workspace/layout/state-paths.js";

// Per-extension settings (.intentic/config/extension-settings.json), keyed by the manifest id (publisher.name).
// Not the capability entry id, so values survive a remove/re-add; secret values live in the vault instead.
// Writes go to the vault first: the failure mode is an orphaned vault row, never a credential in the tracked file.

const FileSchema = z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])));
type SettingsFile = z.infer<typeof FileSchema>;
export type ExtensionSettings = SettingsFile[string];

// Memoized per root: the write queue lives on the object; a fresh instance per call would drop concurrent writes.
const files = new Map<string, JsonFile<SettingsFile>>();

const settingsFile = (root: string): JsonFile<SettingsFile> => {
    const path = statePath(root, ".intentic/config/extension-settings.json");
    const existing = files.get(path);
    if (existing !== undefined) {
        return existing;
    }
    const file = jsonFile<SettingsFile>(path, { parse: (raw) => FileSchema.safeParse(raw).data, fallback: () => ({}) });
    files.set(path, file);
    return file;
};

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
