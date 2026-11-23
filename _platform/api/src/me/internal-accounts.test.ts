import { internalAccountMatcher, isInternalAccount } from "./internal-accounts.js";

/* WHICH ACCOUNTS ARE THE TEAM'S: operators, the hosted canary, and the listed addresses and domains; case and spacing in
 * the config never decide it, and a domain matches itself only, never a longer name ending in it. */

const configWith = (lists: { admins?: string; canary?: string; internal?: string } = {}) => ({
    admin: { emails: lists.admins ?? `` },
    hosted: { canaryEmail: lists.canary ?? `` },
    telemetry: { internalAccounts: lists.internal ?? `` },
});

describe(`internal accounts`, () => {
    it(`counts every operator address and the hosted canary`, () => {
        const internal = internalAccountMatcher(configWith({ admins: ` Owner@Example.com , ops@example.com`, canary: `canary@probe.test` }));
        expect(internal(`owner@example.com`)).toBe(true);
        expect(internal(`OPS@example.com`)).toBe(true);
        expect(internal(`canary@probe.test`)).toBe(true);
        expect(internal(`someone@example.com`)).toBe(false);
    });

    it(`adds listed addresses and whole domains, a domain matching exactly`, () => {
        const internal = internalAccountMatcher(configWith({ internal: `qa@tester.dev, @Team.Example ,, @` }));
        expect(internal(`qa@tester.dev`)).toBe(true);
        expect(internal(`anyone@team.example`)).toBe(true);
        expect(internal(`ANYONE@TEAM.EXAMPLE`)).toBe(true);
        expect(internal(`other@tester.dev`)).toBe(false);
        expect(internal(`someone@notteam.example`)).toBe(false);
        expect(internal(`someone@sub.team.example`)).toBe(false);
    });

    it(`counts nobody on a deployment that lists nobody`, () => {
        expect(isInternalAccount(configWith(), `owner@example.com`)).toBe(false);
        // An empty entry must never match an address without one.
        expect(isInternalAccount(configWith({ admins: `,`, internal: ` , ` }), ``)).toBe(false);
    });
});
