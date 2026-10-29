import type { BorrowedAccount, BorrowOutcome, ShareableAccount, ShareableAccounts } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { refKey, type ShareSource } from "./shareAccounts";

// WHAT THE OWNER'S OTHER SANDBOXES HOLD THAT THIS ONE DOES NOT, as one list (useOtherAccounts.ts reads them). Nobody has
// to pick a sandbox to find out: every one the editor may make a link on is read, and what is already here, or held twice
// over there, is left out, so what remains is only what a press would change.

/** How one of the other sandboxes answered when asked what it holds. */
export type SourceRead =
    | { readonly state: `reading`; readonly source: ShareSource }
    | { readonly state: `read`; readonly source: ShareSource; readonly listing: ShareableAccounts; readonly at: number }
    // A sandbox from before accounts could be shared: it has no such route.
    | { readonly state: `tooOld`; readonly source: ShareSource; readonly at: number }
    // Stopped, asleep, or refused: why, in words.
    | { readonly state: `unreachable`; readonly source: ShareSource; readonly problem: string; readonly at: number };

/** One account another sandbox holds, with where it is. */
export interface OtherAccount {
    // Unique across sources: the source's id and the account's own key.
    readonly key: string;
    readonly source: ShareSource;
    readonly account: ShareableAccount;
}

/** What this sandbox already holds, as far as telling an account over there apart from one here needs. */
export interface HeldHere {
    readonly borrowed: readonly BorrowedAccount[];
    // A provider's own accounts here (borrowed ones among them).
    readonly accountsOf: (provider: string) => readonly OauthAccount[];
    // `endpoint/<id>` providers this sandbox is pointed at.
    readonly endpoints: ReadonlySet<string>;
    // Translator providers holding at least one subscription here.
    readonly subscribed: ReadonlySet<string>;
}

export const otherKey = (sourceId: string, account: Pick<ShareableAccount, `provider` | `account`>): string => `${sourceId}\u0001${refKey(account)}`;

const same = (a: string | undefined, b: string | undefined): boolean =>
    a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Whether `account`, held by `source`, is already here: borrowed from it, or the same account (by who it signs in as,
 * else by its name) connected here some other way. A provider shared whole (a translator's) is here once it holds any.
 */
const heldHere = (account: ShareableAccount, source: ShareSource, here: HeldHere): boolean => {
    if (here.borrowed.some((lent) => lent.provider === account.provider && lent.remote === account.account && lent.from.sandboxId === source.id)) {
        return true;
    }
    if (here.endpoints.has(account.provider) || here.subscribed.has(account.provider)) {
        return true;
    }
    return here
        .accountsOf(account.provider)
        .some((mine) => (account.email !== undefined && mine.email !== undefined ? same(mine.email, account.email) : same(mine.label, account.label)));
};

// Who an account is, across sandboxes: the same sign-in held by two of them (one borrowing it from the other) is one row.
const identity = (account: ShareableAccount): string => `${account.provider}\u0000${(account.email ?? account.label).trim().toLowerCase()}`;

/**
 * Every account the other sandboxes hold that this one does not, each once: where two hold the same, the one that can
 * come here wins, then the first sandbox listed. Those that can come first. An account a press brought in this visit
 * (`outcomes`) stays listed, so its row can say what became of it.
 */
export const otherAccounts = (reads: readonly SourceRead[], here: HeldHere, outcomes: ReadonlyMap<string, BorrowOutcome>): OtherAccount[] => {
    const chosen = new Map<string, OtherAccount>();
    for (const read of reads) {
        if (read.state !== `read`) {
            continue;
        }
        for (const account of read.listing.accounts) {
            const key = otherKey(read.source.id, account);
            if (!outcomes.has(key) && heldHere(account, read.source, here)) {
                continue;
            }
            const who = identity(account);
            const held = chosen.get(who);
            if (held === undefined || (held.account.mode === `no` && account.mode !== `no`)) {
                chosen.set(who, { key, source: read.source, account });
            }
        }
    }
    const all = [...chosen.values()];
    return [...all.filter((row) => row.account.mode !== `no`), ...all.filter((row) => row.account.mode === `no`)];
};

/** The sandboxes a reader could not see into, by why: too old to share, or not answering. */
export const unseen = (reads: readonly SourceRead[]) => ({
    tooOld: reads.filter((read) => read.state === `tooOld`).map((read) => read.source),
    unreachable: reads.filter((read) => read.state === `unreachable`).map((read) => read.source),
});

/** The rows a press brings, by the sandbox each comes from, in the order they were listed. */
export const bySource = (rows: readonly OtherAccount[]): { readonly source: ShareSource; readonly rows: readonly OtherAccount[] }[] => {
    const groups = new Map<string, { source: ShareSource; rows: OtherAccount[] }>();
    for (const row of rows) {
        const group = groups.get(row.source.id) ?? { source: row.source, rows: [] };
        group.rows.push(row);
        groups.set(row.source.id, group);
    }
    return [...groups.values()];
};

/** The first sandbox offering an account of `provider` that can come here, for that provider's own panel. */
export const offerFor = (rows: readonly OtherAccount[], provider: string): OtherAccount | undefined =>
    rows.find((row) => row.account.provider === provider && row.account.mode !== `no`);
