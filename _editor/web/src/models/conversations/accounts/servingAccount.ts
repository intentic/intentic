import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { reportsPlanLimits } from "@intentic/sandbox-contract/models/agent-catalog";
import { moveDestination } from "@intentic/sandbox-contract/models/account-moves";
import { preferredAccount } from "@intentic/sandbox-contract/models/plan-pools";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";

// Which account the next turn runs on, answered here once for every surface that names it (the picker's highlight, the
// pane's reconnect notice). The daemon decides where a turn runs; this reads its rules off the same verdicts it
// publishes (AccountState), so a surface never shows one account while the turn goes to another. Pure: the caller
// hands in the provider's rows in the provider's own order, which is the order the daemon's picks break ties by.

/* ONE RULE FOR EVERY PROVIDER WHOSE ACCOUNTS A PERSON CAN PICK. Each runtime that holds its accounts' own credentials
   (Claude, Cursor, Devin, the minted keys, a vendor CLI's sign-ins) places a turn naming none by the daemon's one rule
   (serviceability.ts unnamedAccount, preferredAccount): room, then unmeasured, then spent. A routed subscription is the
   translator's to balance, and the picker lists it read-only, never through here. Before 2026-10-29 only Claude and
   Cursor read that way here, so the composer read a spent first Devin account as where the turn ran, called the send
   blocked, and a press past that reading named the spent account (composerSend.ts nameBlockedAccount): the turn was
   refused there with two unspent accounts beside it. */

/** The row a turn naming no account runs on. */
export const autoAccount = <T extends { readonly state: AccountState }>(rows: readonly T[]): T | undefined => preferredAccount(rows);

// Whether the daemon moves a turn off the conversation's own account before sending it (blocked-account.ts
// offBlockedAccount, account-placement.ts offSpentAccount): one an organisation switched off, or one the records call
// spent, pinned or not. A routed provider balances its own credentials, so neither rule asks about one.
const leavesRecorded = (provider: AgentProvider, state: AccountState): boolean =>
    !KeyedProviderSchema.safeParse(provider).success && ((state.kind === `blocked` && state.fix === `admin`) || state.kind === `spent`);

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
 * - none held: the sandbox's own pick (autoAccount).
 * - named: runs there whatever its state, and a refusal then says why.
 * - the record: runs there, unless an organisation took the seat or the records call its allowance spent, which moves
 *   the turn where every move goes (account-moves.ts moveDestination) or, with nowhere to go, keeps it there.
 * An account the list no longer has serves nothing: the turn naming it is refused, so no row is where it runs.
 */
export const servingAccount = <T extends { readonly id: string; readonly state: AccountState }>(
    provider: AgentProvider,
    rows: readonly T[],
    next: { readonly account: string | undefined; readonly named: boolean },
): ServingAccount | undefined => {
    if (next.account === undefined) {
        const picked = autoAccount(rows);
        return picked === undefined ? undefined : { id: picked.id, byAllowance: true };
    }
    const held = rows.find((row) => row.id === next.account);
    if (held === undefined) {
        return undefined;
    }
    if (!next.named && leavesRecorded(provider, held.state)) {
        const moved = moveDestination(
            rows.filter((row) => row !== held),
            reportsPlanLimits(provider),
        );
        if (moved !== undefined) {
            return { id: moved.id, byAllowance: true };
        }
    }
    return { id: held.id, byAllowance: false };
};
