import type { AccountState } from "../schemas/providers/plan-limits.js";
import { bestWithRoom, preferredAccount } from "./plan-pools.js";

/* WHERE A TURN GOES OFF AN ACCOUNT THAT CANNOT SERVE IT, for every provider whose accounts a turn can name. Read by the
   daemon's limit move (sibling-account.ts) and its move off a blocked account (blocked-account.ts), and by the editor's
   offer to continue elsewhere (limitFallback.ts) and its reading of where a turn will run (servingAccount.ts), so the four
   never disagree.

   Proven room comes first. A provider that publishes no allowance (Devin, Cursor, the minted keys, a vendor CLI's
   sign-in) never proves room, so there a move may also land on an account nothing has refused, since a refusal is the
   only thing that marks one spent. Before this, a Devin turn refused on a spent account was held for a press, with two
   accounts beside it that nothing had refused (2026-10-29). The turn cannot bounce back and forth: by the time the next
   move is read, the account it just left is on file as spent.

   Where every account with a reading is refused (spent or blocked), an unread one qualifies on a provider that does
   publish an allowance too: a reading that went stale is no refusal. 2026-11-17, the shinobi-society audit: a Claude
   account whose organisation turned Claude Code off left its conversation dead for hours, with a second account beside
   it whose reading had simply aged out. An account at the line still has a reading that is no refusal, so it keeps the
   unread ones out as before. */

interface MovableAccount {
    readonly state: AccountState;
    readonly flapping?: boolean | undefined;
}

// An account whose reading says it cannot serve.
const refused = (state: AccountState): boolean => state.kind === "spent" || state.kind === "blocked";

/**
 * The account a turn moves to among `others` (the account it leaves already left out). That is the best with proven room
 * (plan-pools.ts bestWithRoom: the first to renew unless nearly out, then the most room), else the steadiest unmeasured one where `readable` is false (the provider publishes no allowance) or every
 * account with a reading is refused. Ties keep the caller's order. Undefined: nowhere to go.
 */
export const moveDestination = <T extends MovableAccount>(others: readonly T[], readable: boolean): T | undefined => {
    const withRoom = bestWithRoom(others);
    if (withRoom !== undefined) {
        return withRoom;
    }
    const open = !readable || others.every((entry) => entry.state.kind === "unknown" || refused(entry.state));
    return open ? preferredAccount(others.filter((entry) => entry.state.kind === "unknown")) : undefined;
};
