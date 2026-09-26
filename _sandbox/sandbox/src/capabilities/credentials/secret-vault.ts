import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

// Stores capability credential values under AGENT_AUTH_DIR (mode 0600), outside the file routes, tree walk and search
// index the manifest is subject to, so reading or grepping the manifest never surfaces a credential. Not a barrier
// against a shell: the daemon and agent already share a root container.

// id -> {config key -> value}; an entry with no credentials keeps no row, not an empty object.
const SecretValuesSchema = z.record(z.string(), z.string());
export type SecretVaultContents = Record<string, z.infer<typeof SecretValuesSchema>>;

// Two vaults, one family: the capabilities' and the extensions', the same shape under two names in the auth root.
const vaultFile = (path: string) => ({ root: "auth" as const, path, schema: SecretValuesSchema, granularity: "record" as const });
export const capabilitySecretsDocument = defineDocument(vaultFile("capability-secrets.json"));
export const extensionSecretsDocument = defineDocument(vaultFile("extension-secrets.json"));
export type VaultDocument = typeof capabilitySecretsDocument;

export interface SecretVault {
    // Every stored value for one capability, or {} when it holds none.
    readonly get: (id: string) => Promise<Record<string, string>>;
    // The whole map, one read behind a LIST rehydration rather than one read per entry.
    readonly all: () => Promise<SecretVaultContents>;
    // Replaces one capability's values wholesale; an empty map drops the row.
    readonly set: (id: string, values: Record<string, string>) => Promise<void>;
    readonly remove: (id: string) => Promise<void>;
    // Every value across all capabilities; what the output filter masks by value.
    readonly values: () => Promise<readonly string[]>;
}

// `document` says which vault this is; `path` where it is (under the auth root, or a test's own).
export const fileSecretVault = (document: VaultDocument, path: string): SecretVault => {
    const file = openDocument(document, path, {
        fallback: (): SecretVaultContents => ({}),
        mode: 0o600,
        // Credentials are not state the daemon can regrow: a fresh vault over an unreadable one would drop every one.
        onUnreadable: "refuse",
    });
    return {
        get: async (id) => (await file.read())[id] ?? {},
        all: () => file.read(),
        set: async (id, values) => {
            await file.update((current) => {
                const { [id]: _dropped, ...rest } = current;
                return Object.keys(values).length === 0 ? rest : { ...rest, [id]: values };
            });
        },
        remove: async (id) => {
            await file.update((current) => {
                if (!(id in current)) {
                    // Returned by reference so jsonFile skips the write when there's nothing to remove.
                    return current;
                }
                const { [id]: _dropped, ...rest } = current;
                return rest;
            });
        },
        values: async () => Object.values(await file.read()).flatMap((entry) => Object.values(entry)),
    };
};
