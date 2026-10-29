import type { AccountState } from "../schemas/providers/plan-limits.js";
import { preferredAccount, roomiestAccount } from "./plan-pools.js";

/* WHERE A TURN GOES OFF AN ACCOUNT THAT CANNOT SERVE IT, for every provider whose accounts a turn can name. Read by the
   daemon's limit move (sibling-account.ts) and its move off a blocked account (blocked-account.ts), and by the editor's
   offer to continue elsewhere (limitFallback.ts) and its reading of where a turn will run (servingAccount.ts), so the four
   never disagree.

   Proven room comes first. A provider that publishes no allowance (Devin, Cursor, the minted keys, a vendor CLI's
   sign-in) never proves room, so there a move may also land on an account nothing has refused, since a refusal is the
   only thing that marks one spent. Before this, a Devin turn refused on a spent account was held for a press, with two
   accounts beside it that nothing had refused (2026-10-29). The turn cannot bounce back and forth: by the time the next
   move is read, the account it just left is on file as spent. */

interface MovableAccount {
    readonly state: AccountState;
    readonly flapping?: boolean | undefined;
}

/**
 * The account a turn moves to among `others` (the account it leaves already left out). That is the roomiest with proven
 * room, else, where `readable` is false (the provider publishes no allowance), the steadiest unmeasured one. Ties keep the
 * caller's order. Undefined: nowhere to go.
 */
export const moveDestination = <T extends MovableAccount>(others: readonly T[], readable: boolean): T | undefined =>
    roomiestAccount(others) ?? (readable ? undefined : preferredAccount(others.filter((entry) => entry.state.kind === "unknown")));
