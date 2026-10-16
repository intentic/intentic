import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";
import { loadTextReader, type TextReader } from "@intentic/ocr/paddle-ocr";
import type { EntityRecognizer } from "./masker.js";
import { loadRecognizer, nerInstalled } from "./ner.js";
import { filePrivacyImages } from "./privacy-images.js";
import { filePrivacyLedger, privacyLedgerDocument } from "./privacy-ledger.js";
import { filePrivacyPolicy, privacyShieldDocument } from "./privacy-policy.js";
import { createPrivacyShield, type PrivacyShield } from "./privacy-shield.js";
import { filePrivacyVault, privacyVaultDocument } from "./privacy-vault.js";
import { createLocalReaders } from "./readers.js";
import { sessionTokens } from "./gateway/session-token.js";
import type { Pin } from "../compliance/org-pins.js";

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
    // The organisation's pins over the policy (compliance/org-pins.ts), handed whether a name model is installed; absent for
    // a composition that holds no organisation policy at all, such as a test's.
    readonly pin?: (nameModel: () => Promise<boolean>) => Pin<PrivacyShieldPolicy>;
}

export const createPrivacySlice = ({ authRoot, workspaceRoot, capabilities, loopbackBase, warn, pin }: PrivacyDeps): PrivacySlice => {
    let recognizer: Promise<EntityRecognizer | undefined> | undefined;
    let textReader: Promise<TextReader | undefined> | undefined;
    return {
        privacyShield: createPrivacyShield({
            policyStore: filePrivacyPolicy(join(authRoot, privacyShieldDocument.path), pin?.(async () => nerInstalled()), warn),
            vault: filePrivacyVault(join(authRoot, privacyVaultDocument.path)),
            ledger: filePrivacyLedger(join(workspaceRoot, privacyLedgerDocument.path)),
            // The pictures before masking hold what the vault holds, so they sit beside it rather than beside the log.
            images: filePrivacyImages(join(authRoot, "privacy-images")),
            // The text reader loads on the first image it is asked to check, the name model on the first request for it.
            readers: createLocalReaders({ textReader: () => (textReader ??= loadTextReader(undefined, warn)) }),
            tokens: sessionTokens(join(authRoot, "privacy-gateway.key")),
            capabilities,
            loopbackBase,
            // Loaded once, on the first request that asks for it: a sandbox that never does pays nothing.
            recognizer: () => (recognizer ??= loadRecognizer(undefined, warn)),
            recognizerInstalled: async () => nerInstalled(),
            warn: (message) => warn(message, undefined),
        }),
    };
};
