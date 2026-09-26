import type { Capability } from "@intentic/sandbox-contract";
import type { CapabilitiesSlice } from "./capabilities-slice.js";
import type { CapabilitiesStore } from "./capabilities-store.js";
import type { SecretVault } from "./credentials/secret-vault.js";
import type { DismissalsStore, DismissedRecommendation } from "./offers/dismissals-store.js";

// The capabilities slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

// In-memory capabilities store so the capability routes and turn merge are testable without the fs.
export const memoryCapabilitiesStore = (initial: Capability[] = []): CapabilitiesStore => {
    let capabilities = [...initial];
    return {
        list: async () => capabilities,
        get: async (id) => capabilities.find((capability) => capability.id === id),
        upsert: async (capability) => {
            capabilities = [...capabilities.filter((existing) => existing.id !== capability.id), capability];
        },
        remove: async (id) => {
            const next = capabilities.filter((capability) => capability.id !== id);
            const existed = next.length !== capabilities.length;
            capabilities = next;
            return existed;
        },
    };
};

// An in-memory dismissals store, what the catalog's "not needed" writes to, without the fs.
export const memoryDismissalsStore = (initial: DismissedRecommendation[] = []): DismissalsStore => {
    let dismissed = [...initial];
    return {
        list: async () => dismissed,
        dismiss: async (entry) => {
            dismissed = [...dismissed.filter((existing) => existing.entry !== entry.entry), entry];
        },
    };
};

// In-memory, not unstubbed, for the same reason as the capability store: it sits on every turn's path, not just the
// routes about it (a `secret` extension setting reaches the shell's env through here).
export const memorySecretVault = (initial: Record<string, Record<string, string>> = {}): SecretVault => {
    const rows = new Map(Object.entries(initial));
    return {
        get: async (id) => rows.get(id) ?? {},
        all: async () => Object.fromEntries(rows),
        // An empty map drops the row, like the file vault: the store stays a list of what actually holds a secret.
        set: async (id, values) => {
            if (Object.keys(values).length === 0) {
                rows.delete(id);
            } else {
                rows.set(id, values);
            }
        },
        remove: async (id) => {
            rows.delete(id);
        },
        values: async () => [...rows.values()].flatMap((row) => Object.values(row)),
    };
};

export const capabilitiesSliceFake = () =>
    ({
        tools: [],
        capabilities: memoryCapabilitiesStore(),
        // Nothing declined by default: every suite wants the catalog answering as on a sandbox nobody's said no on.
        capabilityDismissals: memoryDismissalsStore(),
    }) satisfies Partial<CapabilitiesSlice>;
