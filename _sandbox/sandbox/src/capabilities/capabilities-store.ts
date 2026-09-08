import { type Capability, CapabilitySchema, VAULTED } from "@intentic/sandbox-contract";
import { idListFile, type IdListStore } from "../store/id-list-file.js";
import type { ResolvedContribution } from "./contributions.js";
import { partitionSecretValues } from "./secret-fields.js";
import type { SecretVault } from "./secret-vault.js";

// Sandbox-owned manifest of active capabilities, readable/editable by the owner's shell (outside the file-route
// denylist).
// Credential values are vaulted out, not stored here; a bad entry is skipped, not fatal, preserved raw for a later
// build.
export type CapabilitiesStore = IdListStore<Capability>;

// JSON file store on the shared id-list store (store/id-list-file.ts): per-entry validation, skipped entries reported,
// and writes that preserve what this build can't read.
export const fileCapabilitiesStore = (path: string, onInvalid?: (id: string, reason: string) => void): CapabilitiesStore =>
    idListFile(path, CapabilitySchema, onInvalid);

// Decorator, not a file-store change: the manifest keeps a connection's shape, the vault keeps its credential values.
// Reads rehydrate so every caller gets a whole Capability; writes go to the vault first, orphaning at worst.
const hydrate = (capability: Capability, values: Record<string, string>): Capability =>
    Object.keys(values).length === 0 ? capability : ({ ...capability, config: { ...capability.config, ...values } } as Capability);

export const withSecretVault = (
    inner: CapabilitiesStore,
    vault: SecretVault,
    connectors: () => Promise<Map<string, ResolvedContribution>>,
    onUnvaultable?: (id: string, fields: readonly string[]) => void,
): CapabilitiesStore => {
    return {
        list: async () => {
            const [entries, resolved] = await Promise.all([inner.list(), vault.all()]);
            return entries.map((entry) => hydrate(entry, resolved[entry.id] ?? {}));
        },
        get: async (id) => {
            const entry = await inner.get(id);
            return entry === undefined ? undefined : hydrate(entry, await vault.get(id));
        },
        upsert: async (capability) => {
            const { values, unvaultable } = partitionSecretValues(capability, await connectors());
            if (unvaultable.length > 0) {
                onUnvaultable?.(capability.id, unvaultable);
            }
            // A write from an unrehydrated read would vault the marker over the real value; stored wins over the
            // marker.
            const stored = await vault.get(capability.id);
            const merged = Object.fromEntries(
                Object.entries(values).map(([key, value]) => [key, value === VAULTED ? (stored[key] ?? value) : value]),
            );
            await vault.set(capability.id, merged);
            const config = { ...(capability.config as Record<string, unknown>) };
            for (const key of Object.keys(merged)) {
                config[key] = VAULTED;
            }
            await inner.upsert({ ...capability, config } as Capability);
        },
        remove: async (id) => {
            const removed = await inner.remove(id);
            await vault.remove(id);
            return removed;
        },
    };
};

// Sweeps every boot for entries still holding a raw credential (pre-split, pasted back, restored), moved via the vault.
// No-op when a manifest is already correct (every field reads as the marker), avoiding churn on every restart.
export const vaultManifestSecrets = async (
    inner: CapabilitiesStore,
    vault: SecretVault,
    connectors: () => Promise<Map<string, ResolvedContribution>>,
    onUnvaultable?: (id: string, fields: readonly string[]) => void,
): Promise<readonly string[]> => {
    const resolved = await connectors();
    const store = withSecretVault(inner, vault, async () => resolved, onUnvaultable);
    const moved: string[] = [];
    // Raw manifest, deliberately: the decorated read rehydrates, hiding whether an entry ever left the file.
    for (const entry of await inner.list()) {
        const { values } = partitionSecretValues(entry, resolved);
        if (Object.values(values).every((value) => value === VAULTED)) {
            continue;
        }
        // hydrate favors the vault over the manifest; a value already in both means the vault's copy is what's in use.
        await store.upsert(hydrate(entry, await vault.get(entry.id)));
        moved.push(entry.id);
    }
    return moved;
};
