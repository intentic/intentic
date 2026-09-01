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

    // The branch rule cuts a middle because both ends of a branch carry something; this one keeps the front,
    // because the front is the whole of what identifies a login and the tail is a domain or an org suffix.
    it(`clips from the end, and never exceeds the budget once the ellipsis is counted`, () => {
        expect(shortAccount(`x`.repeat(200), [])).toHaveLength(18);
        expect(shortAccount(`abcdefghijklmnopqrstuvwxyz`, [])).toBe(`abcdefghijklmnopq…`);
    });

    // The failure the branch rule warns about, in this rule's own terms: two accounts whose local halves read
    // identically must not both print as "bob", so the domain that tells them apart stays.
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

    /* A conversation the daemon recorded no account for was served by nothing this sandbox stores (the
     * container's env token, a translator subscription), so the card says nothing. Guessing the first
     * connection was a confident name for an account that had never run the session — and the composer guesses
     * from the other end, so the two guesses disagreed in public, which is the report this rule comes from. */
    it(`says nothing about a conversation no stored account served`, () => {
        expect(accountBadge(accounts, undefined)).toBeUndefined();
    });

    // An id is a UUID, so a name the sandbox cannot resolve is worse than silence: a routed provider whose pool
    // nobody picks from has no rows at all, and a disconnected login is an id matching none of them.
    it(`draws nothing when the sandbox cannot name the account`, () => {
        expect(accountBadge([], `a`)).toBeUndefined();
        expect(accountBadge([], undefined)).toBeUndefined();
        expect(accountBadge(accounts, `gone`)).toBeUndefined();
    });

    // The identity rides beside the label rather than inside it, so an account named by its own address does
    // not say the address twice.
    it(`says an identity that only repeats the name once`, () => {
        const named = [account({ id: `c`, label: `bob@acme.com`, email: `bob@acme.com` })];
        expect(accountBadge(named, `c`)?.hint).toBe(`Runs on bob@acme.com`);
    });
});
