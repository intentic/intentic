import type { OauthAccount } from "@intentic/sandbox-contract";

// Which connected account a session's turns run on, as the card spells it (sessionChip.ts's companion); its own module
// so the string rule stays testable.
// Shown since the login choice (of several for one provider) is made once in the composer and otherwise invisible; the
// board reads forty sessions at once.
// Keeps the front, unlike a branch's clipped middle: the front identifies the login, the tail (a shared domain) is
// dropped unless it's the only thing telling two logins apart; the full identity is always on hover.

// Space on the line shared with the model and an elided branch; 18 fits most names before the hover takes over.
const BUDGET = 18;

/** The half of an account name that identifies it: everything before the `@` of an address, else the name. */
const localPart = (label: string): string => {
    const at = label.indexOf(`@`);
    return at > 0 ? label.slice(0, at) : label;
};

/**
 * Account name as the card prints it: domain dropped when the local half is unique among `among` (every account
 * connected for that provider).
 * Clipped from the end to the budget.
 */
export const shortAccount = (label: string, among: readonly string[]): string => {
    const local = localPart(label);
    const ambiguous = among.filter((other) => localPart(other) === local).length > 1;
    const shown = ambiguous ? label : local;
    return shown.length <= BUDGET ? shown : `${shown.slice(0, BUDGET - 1)}…`;
};

/** What the card draws for the account: the clipped name, and the whole of it for the hover. */
export interface AccountBadge {
    readonly label: string;
    readonly hint: string;
}

/**
 * The account chip for a session, or nothing when unnamable (a routed pool, the container's env token, a disconnected
 * login, an unloaded account list); a raw id is a UUID, so naming it wrong is worse than silence.
 * `ran` is what the daemon recorded as having actually served the last turn (AgentSummary.account), not the composer's
 * current pick.
 */
export const accountBadge = (accounts: readonly OauthAccount[], ran: string | undefined): AccountBadge | undefined => {
    const entry = accounts.find((account) => account.id === ran);
    if (entry === undefined) {
        return undefined;
    }
    // Identity sits beside the name, not inside it, like the account rows: a label must still say whose it is.
    const identity = [entry.email, entry.organization].filter((part) => part !== undefined && part !== entry.label).join(` · `);
    const whole = identity === `` ? entry.label : `${entry.label} (${identity})`;
    return {
        label: shortAccount(
            entry.label,
            accounts.map((account) => account.label),
        ),
        hint: `Runs on ${whole}`,
    };
};
