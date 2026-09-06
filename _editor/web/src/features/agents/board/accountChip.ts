import type { OauthAccount } from "@intentic/sandbox-contract";

/* WHICH CONNECTED ACCOUNT A SESSION'S TURNS RUN ON, as a board card spells it — the companion to sessionChip.ts,
 * and its own module for the same reason that one is: a pure string rule with edges worth a test is a rule
 * nobody can check once it is a computed inside a component.
 *
 * WHY THE CARD SAYS IT AT ALL. A sandbox holds several logins of the same provider — a personal plan and a work
 * one, or a pool of them with headroom left in different places — and which one a session spends is a real
 * decision the user makes in the composer and then cannot see anywhere afterwards. The board is where forty
 * sessions are read at once, so it is the one surface where "these three are on the work plan" is a fact rather
 * than a lookup. It is always printed on the card beside the model and the branch (see AgentCard).
 *
 * ── THE SPELLING KEEPS THE FRONT, WHICH IS THE OPPOSITE OF A BRANCH ─────────────────────────────────────────
 * A branch loses its MIDDLE because both of its ends carry something (sessionChip.ts). An account name does not
 * work that way: it is the user's own word for the login ("Work") or the address it signs in as, and what
 * identifies it is the FRONT. The tail is a domain a pool of logins all share — a column of `…@gmail.com` names
 * nothing — so the tail is what goes.
 *
 * ── AND THE DOMAIN GOES FIRST, UNLESS IT IS THE ONLY THING TELLING TWO LOGINS APART ─────────────────────────
 * `bob@acme.com` and `bob@gmail.com` are two accounts whose local halves read identically, and a card that
 * called both of them "bob" would be doing exactly what cutting a branch's tail does: printing the same name
 * for two different things. So the domain is dropped only when the local half is unique among the accounts
 * connected for that provider, which is the same question the model picker's rows ask before they add an
 * identity line under a name (pickerAccounts.ambiguousLabels).
 *
 * The whole of it is never lost: it is on the chip's own hover, spelled with the identity the provider reported. */

/* The room a name has on that line, which it shares with the model and an elided branch. Eighteen fits every
 * name this app suggests and every short local half; past it the reader is being asked to compare two long
 * strings at 10px, which is what the hover is for. */
const BUDGET = 18;

/** The half of an account name that identifies it: everything before the `@` of an address, else the name. */
const localPart = (label: string): string => {
    const at = label.indexOf(`@`);
    return at > 0 ? label.slice(0, at) : label;
};

/**
 * An account's name as the card prints it: no shared domain when the local half stands alone among `among`
 * (every account connected for that provider, this one included), and clipped from the END to the budget.
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
 * The account chip for a session, or nothing when this sandbox cannot name one — a provider whose turns are
 * routed through the translator's own pool (nobody picks those), a turn served by the container's env token, an
 * account disconnected since the turn ran, or a window whose account list has not landed yet. A raw id is a
 * UUID, so naming one badly is worse than silence.
 *
 * `ran` is what the daemon RECORDED for this conversation (AgentSummary.account): the account that actually
 * served its last turn, which for a turn that named none is the one the daemon chose by headroom rather than
 * the first on any list. Absent means nothing this sandbox stores paid for it, so the card says nothing. It
 * used to fall back to the first connected account and explain itself in the hint, which put a confident name
 * on a card for an account that had never run the session — the same guess the composer makes from the other
 * end, and the two disagreed in public.
 */
export const accountBadge = (accounts: readonly OauthAccount[], ran: string | undefined): AccountBadge | undefined => {
    const entry = accounts.find((account) => account.id === ran);
    if (entry === undefined) {
        return undefined;
    }
    // The identity beside the name rather than inside it, exactly as the account rows carry it: the label is the
    // user's to rename, and a renamed account still has to be able to say whose it is.
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
