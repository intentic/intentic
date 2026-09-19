import type { OauthAccount } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { accountBadge, shortAccount } from "./accountChip";

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

    it(`names the account the session recorded, and hangs the whole identity on the hover`, () => {
        expect(accountBadge(accounts, `a`)).toEqual({ label: `Work`, hint: `Runs on Work (bob@acme.com · Acme)` });
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
        expect(accountBadge(named, `c`)?.hint).toBe(`Runs on bob@acme.com`);
    });
});
