import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import type { EntityRecognizer } from "./masker.js";
import { loadRecognizer, nerInstalled } from "./ner.js";
import { filePrivacyLedger, privacyLedgerDocument } from "./privacy-ledger.js";
import { filePrivacyPolicy, privacyShieldDocument } from "./privacy-policy.js";
import { createPrivacyShield, type PrivacyShield } from "./privacy-shield.js";
import { filePrivacyVault, privacyVaultDocument } from "./privacy-vault.js";
import { createLocalReaders } from "./readers.js";
import { sessionTokens } from "./gateway/session-token.js";

// The privacy shield, built once: its policy and vault beside the credentials, its log in the workspace, its readers
// and its optional name model loaded on first use.
export interface PrivacySlice {
    readonly privacyShield: PrivacyShield;
}

export interface PrivacyDeps {
    readonly authRoot: string;
    readonly workspaceRoot: string;
    readonly capabilities: () => Promise<readonly Capability[]>;
    // Where a runtime on this machine reaches the daemon's raw routes.
    readonly loopbackBase: () => string;
    readonly warn: (message: string, error: unknown) => void;
}

export const createPrivacySlice = ({ authRoot, workspaceRoot, capabilities, loopbackBase, warn }: PrivacyDeps): PrivacySlice => {
    let recognizer: Promise<EntityRecognizer | undefined> | undefined;
    return {
        privacyShield: createPrivacyShield({
            policyStore: filePrivacyPolicy(join(authRoot, privacyShieldDocument.path)),
            vault: filePrivacyVault(join(authRoot, privacyVaultDocument.path)),
            ledger: filePrivacyLedger(join(workspaceRoot, privacyLedgerDocument.path)),
            readers: createLocalReaders(),
            tokens: sessionTokens(join(authRoot, "privacy-gateway.key")),
            capabilities,
            loopbackBase,
            // Loaded once, on the first request that asks for it: a sandbox that never does pays nothing.
            recognizer: () => (recognizer ??= loadRecognizer(undefined, warn)),
            recognizerInstalled: async () => nerInstalled(),
        }),
    };
};
