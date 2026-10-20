import { preferredAccount, serviceStates } from "@intentic/sandbox-contract/models/plan-pools";
import type { Services } from "../../composition.js";
import { type CursorStore, liveCursorAccounts, type StoredCursorAccount } from "./accounts/cursor-credentials.js";

// Which Cursor connection a turn runs on. Cursor's API answers /me, /models, /agents and /repositories and has no
// allowance surface at all, so what tells its accounts apart is what each has refused, filed in the one refusal ledger
// (usage/provider-refusals.ts) by a turn's own failure or by hand (usage/spent-by-hand.ts), and judged by the one rule
// every provider's accounts are (plan-pools.ts serviceStates).

export interface CursorPlacementDeps extends Pick<Services, "providerRefusals"> {
    readonly cursorStore: CursorStore;
}

/**
 * A named account is honoured as asked — the picker's whole point is that the choice is the user's — and only an
 * unnamed one is placed, on the account the rule prefers for the model the turn names: one that has not refused it,
 * then one refused only for it, an account refused outright last.
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
    // One account is not a choice, and an unnamed model has no pool to weigh; both keep first-connected-is-default.
    if (live.length < 2 || model === undefined || model === "") {
        return live[0];
    }
    const refusals = (await deps.providerRefusals.onFile())["cursor"] ?? [];
    const states = serviceStates(
        live.map((account) => ({ account: account.id })),
        refusals,
        { id: model },
    );
    return preferredAccount(live.map((stored) => ({ stored, state: states.get(stored.id) ?? { kind: "unknown" as const } })))?.stored;
};
