import { type AccountConnectorsStore, keysBy } from "./account-connectors.js";

// The connector store in memory, for suites that connect accounts without a temp tree: nobody has connected anything
// until a suite records it, and a disconnect forgets it as the file store's does.
export const memoryAccountConnectors = (): AccountConnectorsStore => {
    const held = new Map<string, string>();
    return {
        all: async () => new Map(held),
        record: async (key, email) => {
            held.set(key, email.toLowerCase());
        },
        forget: async (key) => {
            held.delete(key);
        },
        keysOf: async (email) => keysBy(held, email),
    };
};
