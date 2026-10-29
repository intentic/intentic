import { OPEN_BOUNDS, panelBounds, type PeopleManager } from "./accessBounds";

// What someone editing the roster may change of one person, as the contract's bound answers it: the owner and Full access
// change anyone's, their own included; People & access changes anyone's below Full access but its holder's own, never
// grants Full access, and hands out only the rights its holder has.

const ADA: PeopleManager = { email: `ada@acme.dev`, role: `collaborator`, manages: [`people`, `secrets`] };

describe(`panelBounds`, () => {
    it(`leaves everything to the owner and Full access, their own access included`, () => {
        const owner = { email: `owner@acme.dev`, role: `owner` as const };
        expect(panelBounds(owner, `max@acme.dev`, { role: `maintainer` }, `maintainer`)).toEqual(OPEN_BOUNDS);
        const max = { email: `max@acme.dev`, role: `maintainer` as const };
        expect(panelBounds(max, `max@acme.dev`, { role: `maintainer` }, `maintainer`)).toEqual(OPEN_BOUNDS);
    });

    it(`lets People & access change someone below Full access, handing out only the rights it holds`, () => {
        const bounds = panelBounds(ADA, `jo@acme.dev`, { role: `collaborator` }, `collaborator`);
        expect(bounds.locked).toBeUndefined();
        expect(bounds.full).toBe(false);
        expect([...bounds.rights]).toEqual([`people`, `secrets`]);
    });

    it(`keeps a People & access holder's own access, and a Full access person's, read-only`, () => {
        expect(panelBounds(ADA, `ADA@acme.dev`, { role: `collaborator`, manages: [`people`] }, `collaborator`)).toMatchObject({ locked: `own`, full: false });
        const full = panelBounds(ADA, `max@acme.dev`, { role: `maintainer` }, `maintainer`);
        expect(full).toMatchObject({ locked: `full`, full: false });
        expect(full.rights.size).toBe(0);
    });

    // A pending invite the daemon never wrote is read at the platform's tier.
    it(`reads someone the daemon never wrote at the platform's tier`, () => {
        expect(panelBounds(ADA, `rin@acme.dev`, undefined, `maintainer`).locked).toBe(`full`);
        expect(panelBounds(ADA, `rin@acme.dev`, undefined, `viewer`).locked).toBeUndefined();
    });
});
