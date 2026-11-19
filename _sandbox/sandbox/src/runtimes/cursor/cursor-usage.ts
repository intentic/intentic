import { type PlaceDeps, unnamedPlacement } from "../../agent/providers/accounts/placement.js";
import { type CursorStore, liveCursorAccounts, type StoredCursorAccount } from "./accounts/cursor-credentials.js";

// Which Cursor connection a turn runs on. Cursor's API answers /me, /models, /agents and /repositories and has no
// allowance surface at all, so what tells its accounts apart is what each has refused, filed in the one refusal ledger
// (usage/provider-refusals.ts) by a turn's own failure or by hand (usage/spent-by-hand.ts), judged by the one rule every
// provider's accounts are (serviceability.ts), and placed by the one placement every runtime asks (placement.ts
// unnamedPlacement). Until 2026-11-19 this ran the rule itself, on the refusals alone, beside every other runtime's.

export type CursorPlacementDeps = PlaceDeps & {
    readonly cursorStore: CursorStore;
};

/**
 * A named account is honoured as asked — the picker's whole point is that the choice is the user's — and only an
 * unnamed one is placed, among the live connections, on the account the rule prefers for the model the turn names: one
 * that has not refused it, then one refused only for it, an account refused outright last.
 */
export const cursorAccountForTurn = async (
    deps: CursorPlacementDeps,
    requested: string | undefined,
    model: string | undefined,
): Promise<StoredCursorAccount | undefined> => {
    const live = await liveCursorAccounts(deps.cursorStore);
    if (requested !== undefined && requested !== "") {
        return live.find((account) => account.id === requested);
    }
    return unnamedPlacement(deps, "cursor", live, model);
};
