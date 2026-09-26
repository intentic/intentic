import { type MintedStore, type StoredKeyAccount, toMintedAccount } from "./minted-credentials.js";
import type { MintedProviderSlice, MintedSlice } from "./minted-provider.js";

// The minted providers' slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

// Real implementation, not a throwing stub: a suite usually wants to connect an account and then see what a turn
// resolves. Starts empty (no guard depends on these providers); `variant` is required, as on the real store.
export const memoryMintedStore = (providerName: string): MintedStore => {
    let accounts: StoredKeyAccount[] = [];
    const row = (stored: StoredKeyAccount) => toMintedAccount(stored, providerName);
    return {
        list: async () => accounts.map(row),
        credentials: async () => accounts,
        connect: async ({ apiKey, variant, email }) => {
            const stored: StoredKeyAccount = {
                id: `${providerName}-${accounts.length + 1}`,
                apiKey,
                variant,
                connectedAt: accounts.length + 1,
                ...(email !== undefined && email.trim() !== "" ? { email: email.trim() } : {}),
            };
            accounts = [...accounts, stored];
            return row(stored);
        },
        rename: async (id, label) => {
            const stored = accounts.find((account) => account.id === id);
            if (stored === undefined) {
                return undefined;
            }
            const { label: _dropped, ...rest } = stored;
            const renamed = label.trim() === "" ? rest : { ...rest, label: label.trim() };
            accounts = accounts.map((account) => (account.id === id ? renamed : account));
            return row(renamed);
        },
        disconnect: async (id) => {
            accounts = accounts.filter((account) => account.id !== id);
        },
    };
};

// Nothing connected by default (Meta/Z.ai turns are refused); a factory, not a constant, since the store holds state
// suites must not share. Sign-in refuses; a suite needing a real handshake passes its own driver.
export const testMintedSlices = (): MintedSlice["minted"] => {
    const area = (providerName: string, models: { id: string; label: string }[]): MintedProviderSlice => {
        const catalog = { models: async () => ({ models, default: models[0]?.id ?? "" }), forget: () => {} };
        return {
            store: memoryMintedStore(providerName),
            login: async () => {
                throw new Error(`${providerName} sign-in is not available in tests: pass a driver`);
            },
            catalogOf: () => catalog,
            catalog,
        };
    };
    return {
        meta: area("Meta", [{ id: "muse-spark-1.2", label: "Muse Spark 1.2" }]),
        zai: area("Z.ai", [{ id: "glm-5.3", label: "GLM-5.3" }]),
    };
};

export const mintedSliceFake = () => ({ minted: testMintedSlices() }) satisfies MintedSlice;
