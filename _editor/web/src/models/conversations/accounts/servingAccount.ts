import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { reportsPlanLimits } from "@intentic/sandbox-contract/models/agent-catalog";
import { moveDestination } from "@intentic/sandbox-contract/models/account-moves";
import { preferredAccount } from "@intentic/sandbox-contract/models/plan-pools";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import type { DaemonPlacement } from "../../providers/capacity/daemonPlacement";

// Which account the next turn runs on, answered here once for every surface that names it (the picker's highlight, the
// pane's reconnect notice). The daemon decides where a turn runs; this reads its rules off the same verdicts it
// publishes (AccountState), so a surface never shows one account while the turn goes to another. Pure: the caller
// hands in the provider's rows in the provider's own order, which is the order the daemon's picks break ties by, each
// with every fact a pick ranks by (its verdict, and `flapping`). runServing.ts builds those rows, and is the one caller.

/* ONE RULE FOR EVERY PROVIDER WHOSE ACCOUNTS A PERSON CAN PICK. Each runtime that holds its accounts' own credentials
   (Claude, Cursor, Devin, the minted keys, a vendor CLI's sign-ins) places a turn naming none by the daemon's one
   placement (placement.ts unnamedPlacement, over preferredAccount): room (the allowance that renews first, unless nearly
   out), then unmeasured, then spent. Claude's pick also counts what already runs on each account, which this cannot see:
   while children crowd the account renewing first, the turn may go on the next. So a daemon that answers where it would
   place the turn (usage.placement, daemonPlacement.ts) is asked, and this rule only stands in for one that does not. A routed subscription is the
   translator's to balance, and the picker lists it read-only, never through here. Before 2026-10-29 only Claude and
   Cursor read that way here, so the composer read a spent first Devin account as where the turn ran, called the send
   blocked, and a press past that reading named the spent account (composerSend.ts nameBlockedAccount): the turn was
   refused there with two unspent accounts beside it. */

/** What a pick reads of one account: its verdict, and whether its organisation keeps switching it off. */
export interface PlacementRow {
    readonly state: AccountState;
    readonly flapping?: boolean | undefined;
}

/** The row a turn naming no account runs on. */
export const autoAccount = <T extends PlacementRow>(rows: readonly T[]): T | undefined => preferredAccount(rows);

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
    // This window's own prediction, shown while the daemon's answer to where it places the turn is on its way: never named
    // on a turn, which the daemon then places itself (composerSelection.ts sentAccount).
    readonly provisional?: true | undefined;
}

// Where a turn naming no account runs: the daemon's own pick where it answered with one of these rows, else this window's
// prediction by the same rule (autoAccount), provisional while the daemon's answer is still to come. A daemon that names
// no account (one account, or none to choose between) leaves the prediction standing. So does a sandbox-wide answer
// these rows leave out (a daemon from before usage.placement took the loop, or the capacity's pick: an account this
// person may not run on, or one that does not serve the chosen loop, while the turn is narrowed to the rest). An answer
// the daemon narrowed to this person's loop and accounts (`narrowed`) is the turn's, a row this window has not caught up
// with yet included, and nothing here predicts over it.
const unnamed = <T extends PlacementRow & { readonly id: string }>(rows: readonly T[], placed: DaemonPlacement | undefined): ServingAccount | undefined => {
    const daemon = placed?.kind === `placed` ? rows.find((row) => row.id === placed.account) : undefined;
    if (daemon !== undefined) {
        return { id: daemon.id, byAllowance: true };
    }
    if (placed?.kind === `placed` && placed.narrowed === true && placed.account !== undefined) {
        return { id: placed.account, byAllowance: true };
    }
    const picked = autoAccount(rows);
    if (picked === undefined) {
        return undefined;
    }
    return placed?.kind === `pending` ? { id: picked.id, byAllowance: true, provisional: true } : { id: picked.id, byAllowance: true };
};

/**
 * The account the next turn runs on, from the account the selection holds and whether the turn names it
 * (turnRequest.ts accountIntent) or leaves it to the daemon's record of the conversation:
 * - none held: the daemon's own pick (`placed`, daemonPlacement.ts), else the same rule's prediction here (autoAccount).
 * - named: runs there whatever its state, and a refusal then says why.
 * - the record: runs there, unless an organisation took the seat or the records call its allowance spent, which moves
 *   the turn where every move goes (account-moves.ts moveDestination) or, with nowhere to go, keeps it there.
 * An account the list no longer has serves nothing: the turn naming it is refused, so no row is where it runs.
 */
export const servingAccount = <T extends PlacementRow & { readonly id: string }>(
    provider: AgentProvider,
    rows: readonly T[],
    next: { readonly account: string | undefined; readonly named: boolean; readonly placed?: DaemonPlacement | undefined },
): ServingAccount | undefined => {
    if (next.account === undefined) {
        return unnamed(rows, next.placed);
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
