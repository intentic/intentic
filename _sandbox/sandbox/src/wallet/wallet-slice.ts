import { join } from "node:path";
import type { CompositionCore } from "../composition.js";
import { defineSlice } from "../seams/slice.js";
import { fileWalletLedger, walletLedgerDocument, type WalletLedgerStore } from "./wallet-ledger.js";

export interface WalletSlice {
    // Wallet's payment record, one row per attempt reaching policy, opened before and settled after the answer.
    readonly walletLedger: WalletLedgerStore;
}

export const walletSlice = defineSlice<WalletSlice>({
    build: ({ workspace }: Pick<CompositionCore, "workspace">) => ({
        walletLedger: fileWalletLedger(join(workspace.root, walletLedgerDocument.path)),
    }),
});
