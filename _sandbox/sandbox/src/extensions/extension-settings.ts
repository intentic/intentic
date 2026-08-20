import { z } from "zod";
import type { SecretVault } from "../capabilities/secret-vault.js";
import { type JsonFile, jsonFile } from "../store/json-file.js";
import { statePath } from "../workspace/state-paths.js";

/* Per-extension settings values (<workspace>/.intentic/config/extension-settings.json), keyed by the manifest-derived
 * extension id (publisher.name). NOT the capability entry id, so values survive a remove/re-add and the
 * re-clone that is an update; the checkout dir itself stays pristine. Values are the primitive union the
 * contributes.settings descriptors declare.
 *
 * THE SPLIT, and it is the capability manifest's split applied to the same problem one table over. A setting
 * descriptor may declare `secret: true`, which until now changed only what the SETTINGS PAGE showed: the value
 * still sat in this file in the clear, the file is not on the workspace API's locked list, and so an extension's
 * API key was one ordinary `Read` away from the model's context. That is precisely the leak secret-vault.ts was
 * built to close for connector credentials, arriving through the other door.
 *
 * So declared-secret values live in the vault (off /work, mode 0600) and this file keeps everything else. The
 * consequences are the two the capability split had:
 *   - READS REHYDRATE, so every caller, the settings route, the agent's env, an extension's own api.settings,
 *     keeps receiving a whole settings object and none of them had to learn about the vault.
 *   - the file becomes credential-free BY CONSTRUCTION, which is what lets the state table classify it as
 *     ordinary config: tracked in the root repo, so turning on an extension's behaviour is reviewable, and
 *     carried by a bundle without carrying anybody's token.
 *
 * WRITES GO TO THE VAULT FIRST, for the reason the capability store gives: the other order loses a credential
 * outright when the second write fails, while this order's worst case is an orphaned vault row that the next
 * write of that extension overwrites and nothing reads meanwhile. */

const FileSchema = z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])));
type SettingsFile = z.infer<typeof FileSchema>;
export type ExtensionSettings = SettingsFile[string];

/* These two are free functions taking a root rather than a store built at composition, so the file object is
 * memoized per root instead. That memo is required, not a cache: `update`'s write queue lives on the
 * object, so building a fresh one per call would leave two extensions saving at once each reading the old map
 * and the second erasing the first's key, the very lost update the queue exists to stop. One root per process
 * in practice, so this map holds exactly one entry. */
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

/* Which keys of one extension hold a credential, from its own manifest. Passed in rather than resolved here for
 * the reason the capability store takes a connector registry: enumerating extensions is a layer above this file,
 * and reaching up for it would invert the dependency. A resolver that knows nothing about an id, an extension
 * removed while a value survives it, answers with an empty set, which leaves that id's values in the tracked
 * file. That is the safe direction only because it is also the honest one: nothing declares those keys secret
 * any more, so nothing can say they are. */
export type SecretKeyResolver = (extensionId: string) => ReadonlySet<string>;

/* The vault takes strings, because a credential is text, a token, a key, a password. A setting declared
 * `secret` with a number or boolean value is therefore a shape nobody has introduced yet, and it must not fail
 * QUIETLY: left in the tracked file it would be exactly the leak this split closes, so the caller is handed the
 * names and says so in the log rather than writing it and moving on. Mirrors partitionSecretValues. */
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

// The whole map, vault values merged over the tracked file, what every existing reader expects to receive.
export const readAllExtensionSettings = async (root: string, vault: SecretVault): Promise<SettingsFile> => {
    const [stored, vaulted] = await Promise.all([settingsFile(root).read(), vault.all()]);
    const ids = new Set([...Object.keys(stored), ...Object.keys(vaulted)]);
    // Vault last, so a value that is in both wins from the vault, which is what the settings route already
    // wrote and what every reader is therefore already using. Spreading an absent id is a no-op, no fallback.
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

/* THE SPLIT AS AN INVARIANT RATHER THAN A WRITE-TIME HABIT, the twin of vaultManifestSecrets, and needed for
 * the same reason: `writeExtensionSettings` is the only thing that vaults, so the tracked file is clean only for
 * the extensions saved since it did. A value written by the agent's own file tools, restored from an export, or
 * stored before a descriptor gained `secret: true` sits there in the clear, and nothing rewrites it because
 * nothing re-saves a setting that is working. The file is deliberately readable and deliberately editable, so
 * "a credential is in there" is a state the system can re-enter at any time.
 *
 * It matters more here than it did for capabilities, because this file is now TRACKED: an unswept value would
 * not merely be readable, it would be committed. So the sweep runs before the gate opens and says nothing when
 * there is nothing to move. Entries already clean are left untouched, which keeps this from churning the file
 * (and its watchers) on every restart. */
export const vaultExtensionSettingSecrets = async (
    root: string,
    vault: SecretVault,
    secretKeysOf: SecretKeyResolver,
    onUnvaultable?: (id: string, keys: readonly string[]) => void,
): Promise<readonly string[]> => {
    // The RAW tracked file, deliberately: a rehydrated read shows a vaulted value exactly as it shows one that
    // never left the file, which is the difference this has to see.
    const stored = await settingsFile(root).read();
    const moved: string[] = [];
    for (const [extensionId, settings] of Object.entries(stored)) {
        const secretKeys = secretKeysOf(extensionId);
        const { values, unvaultable } = partitionSettingValues(settings, secretKeys);
        // Reported on its own rather than through the write below: an unvaultable value has nowhere else to go,
        // so rewriting the file would change nothing and only churn it (and its watchers) on every restart.
        if (unvaultable.length > 0) {
            onUnvaultable?.(extensionId, unvaultable);
        }
        if (Object.keys(values).length === 0) {
            continue;
        }
        /* The VAULT wins where both hold a key, because the vault is what readers already see (rehydration
         * merges it over the file). Moving the file's copy in would quietly swap the credential a working
         * extension authenticates with, the same trap vaultManifestSecrets documents. */
        const merged = { ...settings, ...(await vault.get(extensionId)) };
        await writeExtensionSettings(root, vault, extensionId, merged, secretKeys);
        moved.push(extensionId);
    }
    return moved;
};
