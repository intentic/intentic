import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { Tip } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { sameAddress, type SessionMark } from "../../../../models/agent-status/ownership";

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

/** Account name as the card prints it: domain dropped when the local half is unique among `among` (every account connected for that provider). */
export const shortAccount = (label: string, among: readonly string[]): string => {
    const local = localPart(label);
    const ambiguous = among.filter((other) => localPart(other) === local).length > 1;
    const shown = ambiguous ? label : local;
    return shown.length <= BUDGET ? shown : `${shown.slice(0, BUDGET - 1)}…`;
};

/** What the card draws for the account: the clipped name, and the whole of it for the hover, one fact a row. */
export interface AccountBadge {
    readonly label: string;
    readonly hint: Tip;
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
    // Identity sits beside the name, not inside it, like the account rows: a label must still say whose it is. A row
    // repeating the name says nothing, so it is left empty and the card drops it.
    const beside = (part: string | undefined): string => (part === undefined || part === entry.label ? `` : part);
    return {
        label: shortAccount(
            entry.label,
            accounts.map((account) => account.label),
        ),
        hint: {
            title: t(`shared.account`),
            rows: [
                { label: t(`shared.name`), value: entry.label },
                { label: t(`agents.words.email`), value: beside(entry.email) },
                { label: t(`agents.accountChip.org`), value: beside(entry.organization) },
            ],
        },
    };
};

/**
 * What the owner's hover says about the login, when the login that served a session is its owner's own (matched by
 * address): the card then says that person once, as the owner, rather than once as owner and again as the account,
 * which read as two people. Nothing when the login is somebody else's or unnamable, and the account chip stays.
 */
export const ownersAccount = (accounts: readonly OauthAccount[], ran: string | undefined, ownerEmail: string): string | undefined => {
    const entry = accounts.find((account) => account.id === ran);
    if (entry === undefined || !(sameAddress(ownerEmail, entry.email) || sameAddress(ownerEmail, entry.label))) {
        return undefined;
    }
    // A login named by its own address adds nothing to "their own"; one the owner named ("Work") keeps that name.
    return sameAddress(ownerEmail, entry.label) ? t(`agents.ownerMark.ownAccount`) : t(`agents.ownerMark.ownAccountNamed`, { label: entry.label });
};

/**
 * Everything a card says about the login: the owner's hover line when it is a colleague's own (`own`), else the chip
 * (`badge`). Owner and account side by side read as two people; somebody else's login keeps its chip, since whose
 * quota paid is then news.
 */
export const sessionLogin = (
    accounts: readonly OauthAccount[],
    ran: string | undefined,
    owner: SessionMark | undefined,
): { readonly badge?: AccountBadge | undefined; readonly own?: string | undefined } => {
    const own = owner?.kind === `person` ? ownersAccount(accounts, ran, owner.look.email) : undefined;
    return own === undefined ? { badge: accountBadge(accounts, ran) } : { own };
};
