import type { AgentProvider, ModelRef, OauthAccount } from "@intentic/sandbox-contract";
import { SPENT_PERCENT, usagePercent, usageStatusFor } from "./usageStatus";

/* THE ACCOUNT A SPENT ALLOWANCE CAN BE ANSWERED WITH, and the whole of why this exists as its own answer.
 *
 * A refused turn is already held whole by the daemon, and re-running it takes the conversation's CURRENT
 * credential (Conversation.resumeHeldTurn posts `routing.account`). So "continue on an account that still has
 * room" was always one `selectAccount` plus the press the strip already carries — two gestures the user had to
 * know were related, on a screen whose only stated way on was to wait for the reset. selectAccount's own header
 * says as much: "the answer to it is usually on a different account".
 *
 * WHY THIS IS NOT THE CLI'S `/limit-reset`. That command is upstream's escape hatch for the same moment, it is
 * gated behind a server-side feature flag that is off for every account here, and it spends a once-a-week grant
 * when it does work. This spends nothing: it moves the turn to a pool the user already pays for.
 *
 * ONLY EVER OFFERED FROM A READING WITH ROOM IN IT. `isSpent` answers false for an account nobody has measured
 * (usagePercent is undefined there), so the negative test would have offered an unmeasured account as though it
 * were a known-good one, and the press would have spent a round trip to land on the same wall. The positive test
 * is the honest one, and it costs nothing to satisfy: the accounts list carries each account's headroom and
 * seeds the shared map as it lands (useChat.refreshAccounts), so a page load already knows.
 *
 * Readings arrive through usageStatusFor, which folds in what the plan has SINCE refused (spentByRefusal), so
 * the account that was just turned away reads spent here even while its own last poll still says otherwise, and
 * a routed refusal that names no account at all correctly rules out every connection the provider holds. */

// One offerable account and the headroom that made it offerable, so a caller can both name it and rank it.
interface Candidate {
    readonly account: OauthAccount;
    readonly percent: number;
}

const offerable = (provider: AgentProvider, model: ModelRef | undefined, account: OauthAccount): Candidate | undefined => {
    // A credential the provider has stopped accepting is not headroom, whatever its last poll said: the press
    // would land on a reconnect prompt, which is a worse answer than the wait it replaced.
    if (account.needsReauth === true) {
        return undefined;
    }
    const percent = usagePercent(usageStatusFor(provider, account.id, model), model);
    return percent !== undefined && percent < SPENT_PERCENT ? { account, percent } : undefined;
};

/* The account this conversation could continue on right now, or undefined when nothing can honestly be offered
 * (one connection, or every other one is spent, unmeasured or needs reconnecting).
 *
 * EMPTIEST FIRST, not first-connected: the press is made once, in front of someone who has just been refused,
 * and landing them on the account nearest its own ceiling is how one press becomes three. Ties keep the list's
 * order so the choice is stable across re-renders rather than jittering as polls land.
 */
export const fallbackAccount = (
    provider: AgentProvider,
    current: string | undefined,
    accounts: readonly OauthAccount[],
    model?: ModelRef,
): OauthAccount | undefined => {
    const candidates = accounts
        .filter((account) => account.id !== current)
        .map((account) => offerable(provider, model, account))
        .filter((candidate): candidate is Candidate => candidate !== undefined);
    return candidates.reduce<Candidate | undefined>(
        (best, candidate) => (best === undefined || candidate.percent < best.percent ? candidate : best),
        undefined,
    )?.account;
};

/* WHOSE ACCOUNT IT IS, in the fewest words that still identify it on a button. The email is what the provider
 * itself returns and what the account rows show, so it is what someone recognises; the local part alone is
 * enough when every connection is a personal address, and the label is the fallback for a credential that
 * carries no identity at all (a pasted API key), which is exactly the case renaming exists for. */
export const fallbackLabel = (account: OauthAccount): string => account.email?.split(`@`)[0] ?? account.label;
