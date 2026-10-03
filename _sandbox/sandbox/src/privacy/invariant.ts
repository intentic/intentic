import type { InvariantCheck } from "../invariants/invariants.js";

/*
 * No runtime invariant: each record the shield keeps has one writer and answers to no other record. The policy is read
 * fresh on every request, the ledger holds counts and never a value, and the vault's one promise, that a token's index is
 * never handed out twice, lives inside the vault's own file and is re-derived from its entries on load (a counter that
 * lags them is corrected, not trusted), pinned by tests/privacy-vault.integration.test.ts.
 */

export const owner = "privacy";

export const checks = (): readonly InvariantCheck[] => [];
