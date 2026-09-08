import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

// Stores capability credential values under AGENT_AUTH_DIR (mode 0600), outside the file routes, tree walk and search
// index the manifest is subject to, so reading or grepping the manifest never surfaces a credential. Not a barrier
// against a shell: the daemon and agent already share a root container.

// id -> {config key -> value}; an entry with no credentials keeps no row, not an empty object.
const VaultSchema = z.record(z.string(), z.record(z.string(), z.string()));
export type SecretVaultContents = z.infer<typeof VaultSchema>;

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

export const fileSecretVault = (path: string): SecretVault => {
    const file = jsonFile<SecretVaultContents>(path, {
        parse: (raw) => {
            const parsed = VaultSchema.safeParse(raw);
            return parsed.success ? parsed.data : undefined;
        },
        fallback: () => ({}),
        mode: 0o600,
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
