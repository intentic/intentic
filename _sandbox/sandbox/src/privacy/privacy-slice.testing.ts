import { randomBytes } from "node:crypto";
import { type Capability, DEFAULT_PRIVACY_SHIELD, type PrivacyLedgerEntry, type PrivacyShieldPolicy } from "@intentic/sandbox-contract";
import type { JsonFile } from "../store/json-file.js";
import type { PrivacyLedger } from "./privacy-ledger.js";
import { createPrivacyShield } from "./privacy-shield.js";
import type { PrivacySlice } from "./privacy-slice.js";
import { createPrivacyVault, type VaultValue } from "./privacy-vault.js";
import type { LocalReaders } from "./readers.js";
import { sessionTokensFrom } from "./gateway/session-token.js";

// The privacy shield as route suites stand it up (harness/route-services.testing.ts): the real shield, off by default as
// a fresh sandbox is, over an in-memory policy, log, vault and signing key, so a suite that stands it up touches no disk.
// Not part of the build.

// The vault's document held in memory, as the file store would hold it after reading it.
export const memoryVaultFile = (initial: VaultValue = { next: {}, entries: [] }): JsonFile<VaultValue> => {
    let value = initial;
    return {
        read: async () => value,
        state: async () => ({ value, unreadable: false }),
        update: async (change) => {
            value = change(value);
            return value;
        },
    };
};

export const memoryPrivacyLedger = (): PrivacyLedger & { readonly entries: PrivacyLedgerEntry[] } => {
    const entries: PrivacyLedgerEntry[] = [];
    return {
        entries,
        recent: async () => [...entries].reverse(),
        record: async (entry) => {
            entries.push(entry);
        },
    };
};

// No reader installed, as on an image without the privacy pack.
export const noReaders: LocalReaders = { ocr: async () => false, readImage: async () => undefined, readPdf: async () => undefined };

export interface PrivacyFakeOptions {
    readonly policy?: Partial<PrivacyShieldPolicy>;
    readonly capabilities?: () => Promise<readonly Capability[]>;
    readonly readers?: LocalReaders;
    readonly loopbackBase?: string;
}

export const privacySliceFake = (
    options: PrivacyFakeOptions = {},
): PrivacySlice & { readonly privacyLedger: ReturnType<typeof memoryPrivacyLedger> } => {
    let policy: PrivacyShieldPolicy = { ...DEFAULT_PRIVACY_SHIELD, ...options.policy };
    const ledger = memoryPrivacyLedger();
    const key = randomBytes(32);
    return {
        privacyLedger: ledger,
        privacyShield: createPrivacyShield({
            policyStore: {
                get: async () => policy,
                set: async (next) => {
                    policy = next;
                },
            },
            vault: createPrivacyVault(memoryVaultFile(), "memory"),
            ledger,
            readers: options.readers ?? noReaders,
            tokens: sessionTokensFrom(async () => key),
            capabilities: options.capabilities ?? (async () => []),
            loopbackBase: () => options.loopbackBase ?? "http://127.0.0.1:9",
            recognizer: async () => undefined,
            recognizerInstalled: async () => false,
        }),
    };
};
