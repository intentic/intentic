import { type AccountState, type AgentProvider, preferredAccount, roomiestAccount } from "@intentic/sandbox-contract";

// Which account the next turn runs on, answered here once for every surface that names it (the picker's highlight, the
// pane's reconnect notice). The daemon decides where a turn runs; this reads its rules off the same verdicts it
// publishes (AccountState), so a surface never shows one account while the turn goes to another. Pure: the caller
// hands in the provider's rows in the provider's own order, which is the order the daemon's picks break ties by.

// Runtimes that place a turn naming no account by what each account has left: Claude by the serviceability rule itself
// (harness-credentials.ts, preferredAccount), Cursor by its ledger of refusals (cursor-usage.ts), which a row reads as a
// spent pool. Cursor, alone, differs when every account is spent for the model: it takes the one refused longest ago.
// Every other runtime runs such a turn on its first connected account.
const PICKS_BY_ALLOWANCE: ReadonlySet<AgentProvider> = new Set<AgentProvider>([`claude`, `cursor`]);

/** The row a turn naming no account runs on, by its runtime's own rule. */
export const autoAccount = <T extends { readonly state: AccountState }>(provider: AgentProvider, rows: readonly T[]): T | undefined =>
    PICKS_BY_ALLOWANCE.has(provider) ? preferredAccount(rows) : rows[0];

/** Where the next turn runs. */
export interface ServingAccount {
    readonly id: string;
    // Placed by what the accounts have left, not by a person or the conversation's record: said on the row, since a
    // highlight nobody chose reads as a choice somebody made.
    readonly byAllowance: boolean;
}

/**
 * The account the next turn runs on, from the account the selection holds and whether the turn names it
 * (turnRequest.ts accountIntent) or leaves it to the daemon's record of the conversation:
 * - none held: the runtime's own pick (autoAccount).
 * - named: runs there whatever its state, and a refusal then says why.
 * - the record: runs there, unless an organisation took the seat, which moves the turn to the roomiest ready account
 *   (blocked-account.ts) or, with none, holds it there.
 * An account the list no longer has serves nothing: the turn naming it is refused, so no row is where it runs.
 */
export const servingAccount = <T extends { readonly id: string; readonly state: AccountState }>(
    provider: AgentProvider,
    rows: readonly T[],
    next: { readonly account: string | undefined; readonly named: boolean },
): ServingAccount | undefined => {
    if (next.account === undefined) {
        const picked = autoAccount(provider, rows);
        return picked === undefined ? undefined : { id: picked.id, byAllowance: PICKS_BY_ALLOWANCE.has(provider) };
    }
    const held = rows.find((row) => row.id === next.account);
    if (held === undefined) {
        return undefined;
    }
    // Claude only, as the daemon's move is: only Claude's accounts carry the seat and entitlement marks.
    if (!next.named && provider === `claude` && held.state.kind === `blocked` && held.state.fix === `admin`) {
        const moved = roomiestAccount(rows.filter((row) => row !== held));
        if (moved !== undefined) {
            return { id: moved.id, byAllowance: true };
        }
    }
    return { id: held.id, byAllowance: false };
};
