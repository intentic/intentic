import type { SshKeyStore } from "../ssh-key-store.js";
import type { BrokerSlice } from "./broker-slice.js";

// An ssh key store held in memory: aliases and keys a suite puts, nothing on disk. Not part of the build.
export const memorySshKeyStore = (initial: Readonly<Record<string, string>> = {}): SshKeyStore => {
    const keys = new Map(Object.entries(initial));
    return {
        dir: "/nonexistent/ssh-keys",
        pathOf: (alias) => `/nonexistent/ssh-keys/${alias}`,
        put: async (alias, privateKey) => {
            keys.set(alias, privateKey);
        },
        get: async (alias) => keys.get(alias),
        has: async (alias) => keys.has(alias),
        remove: async (alias) => {
            keys.delete(alias);
        },
        aliases: async () => [...keys.keys()].toSorted(),
    };
};

// The broker slice as a fresh sandbox has it: no ssh key held, so a turn binds no ssh agent socket (capabilities/turn-env.ts).
export const brokerSliceFake = () => ({ sshKeys: memorySshKeyStore() }) satisfies Partial<BrokerSlice>;
