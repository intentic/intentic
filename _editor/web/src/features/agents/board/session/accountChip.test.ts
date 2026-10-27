import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { accountBadge, ownersAccount, sessionLogin, shortAccount } from "./accountChip";

const account = (over: Partial<OauthAccount> & Pick<OauthAccount, "id" | "label">): OauthAccount => ({ connectedAt: 1, ...over });

describe(`shortAccount`, () => {
    it(`leaves a name somebody typed alone`, () => {
        expect(shortAccount(`Work`, [`Work`, `Personal`])).toBe(`Work`);
    });

    it(`drops the domain a pool of logins all share, which names none of them`, () => {
        const among = [`radarsuspam@gmail.com`, `radarsuspam12@gmail.com`];
        expect(shortAccount(`radarsuspam12@gmail.com`, among)).toBe(`radarsuspam12`);
    });

    // Unlike the branch rule (which cuts the middle), this keeps the front and clips the end.
    // The front is what identifies a login; the tail is only a domain or org suffix.
    it(`clips from the end, and never exceeds the budget once the ellipsis is counted`, () => {
        expect(shortAccount(`x`.repeat(200), [])).toHaveLength(18);
        expect(shortAccount(`abcdefghijklmnopqrstuvwxyz`, [])).toBe(`abcdefghijklmnopq…`);
    });

    // Two accounts with identical local parts must not both print as "bob"; the domain that actually tells them apart
    // stays.
    it(`keeps the domain when it is the only thing telling two logins apart`, () => {
        const among = [`bob@acme.com`, `bob@gmail.com`];
        expect(shortAccount(`bob@acme.com`, among)).toBe(`bob@acme.com`);
        expect(shortAccount(`bob@acme.com`, among)).not.toBe(shortAccount(`bob@gmail.com`, among));
    });
});

describe(`accountBadge`, () => {
    const accounts = [account({ id: `a`, label: `Work`, email: `bob@acme.com`, organization: `Acme` }), account({ id: `b`, label: `Personal` })];

    it(`names the account the session recorded, and hangs the whole identity on the hover, one fact a row`, () => {
        expect(accountBadge(accounts, `a`)).toEqual({
            label: `Work`,
            hint: {
                title: `Account`,
                rows: [
                    { label: `Name`, value: `Work` },
                    { label: `Email`, value: `bob@acme.com` },
                    { label: `Organization`, value: `Acme` },
                ],
            },
        });
    });

    // No stored account served this conversation (a container env token, a translator subscription), so the card says
    // nothing.
    // Guessing the first connection would be a confidently wrong name, disagreeing with what the composer guesses
    // independently.
    it(`says nothing about a conversation no stored account served`, () => {
        expect(accountBadge(accounts, undefined)).toBeUndefined();
    });

    // An id is a UUID, so an unresolvable name is worse than silence: a routed provider's pool has no rows at all, and
    // a disconnected login is an id matching none.
    it(`draws nothing when the sandbox cannot name the account`, () => {
        expect(accountBadge([], `a`)).toBeUndefined();
        expect(accountBadge([], undefined)).toBeUndefined();
        expect(accountBadge(accounts, `gone`)).toBeUndefined();
    });

    // Identity rides beside the label, not inside it, so an account named by its own address doesn't say the address
    // twice.
    it(`says an identity that only repeats the name once`, () => {
        const named = [account({ id: `c`, label: `bob@acme.com`, email: `bob@acme.com` })];
        // The tip card drops a row with an empty value, so the address is said once, as the name.
        expect(accountBadge(named, `c`)?.hint.rows?.map((row) => row.value)).toEqual([`bob@acme.com`, ``, ``]);
    });
});

describe(`ownersAccount`, () => {
    const accounts = [
        account({ id: `own`, label: `Dawid@Acme.com` }),
        account({ id: `named`, label: `Work`, email: `dawid@acme.com` }),
        account({ id: `other`, label: `bob@acme.com`, email: `bob@acme.com` }),
    ];

    // The owner and the login that served the turn are one person, so the card says them once, on the owner.
    it(`folds a login named by the owner's address into the owner, whatever its case`, () => {
        expect(ownersAccount(accounts, `own`, `dawid@acme.com`)).toBe(`Their own`);
    });

    it(`keeps the name the owner gave their login`, () => {
        expect(ownersAccount(accounts, `named`, `dawid@acme.com`)).toBe(`Work, their own`);
    });

    // Somebody else's quota paying for the turn is the fact worth a chip of its own.
    it(`leaves somebody else's login, and an unnamable one, to the account chip`, () => {
        expect(ownersAccount(accounts, `other`, `dawid@acme.com`)).toBeUndefined();
        expect(ownersAccount(accounts, `gone`, `dawid@acme.com`)).toBeUndefined();
        expect(ownersAccount(accounts, undefined, `dawid@acme.com`)).toBeUndefined();
    });
});

describe(`sessionLogin`, () => {
    const accounts = [account({ id: `own`, label: `dawid@acme.com` }), account({ id: `other`, label: `bob@acme.com` })];
    const dawid = { kind: `person` as const, look: { email: `dawid@acme.com`, name: `dawid@acme.com`, short: `dawid`, hue: 0, mine: false } };

    // One person, said once: no chip beside the owner who is also the login.
    it(`moves a colleague's own login into the owner's hover and drops the chip`, () => {
        expect(sessionLogin(accounts, `own`, dawid)).toEqual({ own: `Their own` });
    });

    // The reader's own card has no owner mark, so the chip is the only place the login is named.
    it(`keeps the chip for another person's login and for a card with no owner drawn`, () => {
        expect(sessionLogin(accounts, `other`, dawid).badge?.label).toBe(`bob`);
        expect(sessionLogin(accounts, `own`, undefined).badge?.label).toBe(`dawid`);
    });
});
