import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* WHERE A CAPABILITY'S CREDENTIAL VALUES ACTUALLY LIVE, off the workspace, so the manifest the agent reads
 * carries the shape of a connection and never the secret in it.
 *
 * The manifest (.intentic/config/capabilities.json) was the single home for both, and it had to be readable: an agent
 * is regularly asked to find and edit connected services, so the file API's denylist and the search floor both
 * exempt it on purpose. That left every credential one ordinary file read away from the model's context,
 * including the two the product promises are never shown it, a browser account's password and a TOTP seed. The
 * split keeps the manifest exactly as useful and takes the values out of it.
 *
 * Sited under the AI-provider credential root (AGENT_AUTH_DIR, `/agent-auth` in a real sandbox), which is
 * already off /work entirely and therefore already outside the file routes, the tree walk and the search index,
 * the same move that was made for provider logins, for the same reason. Mode 0600.
 *
 * WHAT THIS IS NOT is a wall against a shell. The daemon and the agent both run as root in one container, so a
 * process that goes looking can still open this file; the sandbox boundary, not the filesystem, is what the
 * threat model rests on (SECURITY.md is explicit that a shell in the sandbox is out of scope). What the split
 * removes is the leak that does NOT require going looking, a credential arriving in the model's context as a
 * side effect of reading, searching or grepping a manifest it was asked to edit.
 */

// id → { config key → value }. An entry with no credentials keeps no row at all rather than an empty object, so
// the file stays a list of what actually holds a secret.
const VaultSchema = z.record(z.string(), z.record(z.string(), z.string()));
export type SecretVaultContents = z.infer<typeof VaultSchema>;

export interface SecretVault {
    // Every stored value for one capability, or {} when it holds none.
    readonly get: (id: string) => Promise<Record<string, string>>;
    // The whole map, one read behind a LIST rehydration, rather than one file read per entry.
    readonly all: () => Promise<SecretVaultContents>;
    // Replace one capability's stored values wholesale. An empty map drops the row.
    readonly set: (id: string, values: Record<string, string>) => Promise<void>;
    readonly remove: (id: string) => Promise<void>;
    // Every value the vault holds, across all capabilities, what the agent's output filter masks by value.
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
                    // Unchanged BY REFERENCE, which is what makes jsonFile skip the write, removing a
                    // capability that never stored a credential must not rewrite the file.
                    return current;
                }
                const { [id]: _dropped, ...rest } = current;
                return rest;
            });
        },
        values: async () => Object.values(await file.read()).flatMap((entry) => Object.values(entry)),
    };
};
