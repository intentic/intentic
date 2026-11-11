/* A RUNNER'S TURN HOLDS THIS SANDBOX'S TOKEN TOO. A local turn claims its Claude account for its lifetime (holdAccount),
   so the quiet-moment rotation waits for a gap and a forced one warns that it breaks the turns holding it. A turn on a
   runner borrows the same token through the credential door and was counted by nobody here: on 2026-11-11 a 55-minute
   Opus turn on omen-runner was refused "OAuth token revoked" seventeen minutes after this sandbox rotated the account in
   what it read as a quiet moment. Now every Claude account lent to a runner is held here while a turn dispatched to that
   runner is open, and released when the last one closes. The door does not say which turn asked (a helper job asks
   too), so the hold is the runner's, not the turn's: a few minutes held too long only defer a rotation that the
   two-minute floor still forces (claude-credentials.ts ROTATE_REGARDLESS_MS). */

interface RunnerHolds {
    // Dispatches to this runner open right now.
    open: number;
    // The account holds taken for it, released together when `open` falls to zero.
    readonly releases: Map<string, () => void>;
    // The access token last lent to this runner per account: what its turn was refused on, for the re-mint to supersede.
    readonly lent: Map<string, string>;
}

const runners = new Map<string, RunnerHolds>();

const holdsOf = (runnerId: string): RunnerHolds => {
    let holds = runners.get(runnerId);
    if (holds === undefined) {
        holds = { open: 0, releases: new Map(), lent: new Map() };
        runners.set(runnerId, holds);
    }
    return holds;
};

/** A turn was dispatched to `runnerId`; the answer closes it, once, in the dispatch's finally. */
export const openRunnerTurn = (runnerId: string): (() => void) => {
    const holds = holdsOf(runnerId);
    holds.open += 1;
    let closed = false;
    return () => {
        if (closed) {
            return;
        }
        closed = true;
        holds.open = Math.max(0, holds.open - 1);
        if (holds.open > 0) {
            return;
        }
        const releases = [...holds.releases.values()];
        holds.releases.clear();
        for (const release of releases) {
            release();
        }
    };
};

/**
 * The credential door lent `token` of Claude account `account` to `runnerId`: held here, through `hold` (the Claude
 * store's holdAccount, which the door hands in), while a turn there is open.
 */
export const lentToRunner = (runnerId: string, account: string, token: string, hold: (account: string) => () => void): void => {
    const holds = holdsOf(runnerId);
    holds.lent.set(account, token);
    if (holds.open > 0 && !holds.releases.has(account)) {
        holds.releases.set(account, hold(account));
    }
};

/** The token last lent to `runnerId` for `account`, which a turn refused there was holding; undefined if none was. */
export const lastLentToRunner = (runnerId: string, account: string): string | undefined => runners.get(runnerId)?.lent.get(account);

/** How many dispatches to `runnerId` are open and which accounts are held for them. For tests. */
export const runnerHoldsOf = (runnerId: string) => {
    const holds = runners.get(runnerId);
    return { open: holds?.open ?? 0, held: [...(holds?.releases.keys() ?? [])] };
};
