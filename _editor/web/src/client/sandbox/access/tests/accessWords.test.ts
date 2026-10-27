import { accessWords } from "../accessWords";

// One sentence per refusal, the same wherever it is said, in the app's role words and never the daemon's.

describe(`accessWords`, () => {
    it(`names who a place is for and what the person can still do`, () => {
        expect(accessWords({ kind: `tier`, floor: `maintainer` }, { place: `Secrets` })).toEqual({
            short: `Maintainers only`,
            title: `Only maintainers can open Secrets`,
            note: `You can look around. Only maintainers can change things here.`,
            line: `Ask the owner for access. It opens here as soon as they grant it.`,
        });
    });

    it(`says the request is on its way once the person asked`, () => {
        expect(accessWords({ kind: `agents-off` }, { asked: true }).line).toBe(`You asked the owner for access. It opens here as soon as they grant it.`);
    });

    it(`sends an organisation's lock to its admin rather than to the owner`, () => {
        expect(accessWords({ kind: `org`, org: `Acme`, section: `models` }, { place: `Models` })).toEqual({
            short: `Managed by Acme`,
            title: `Acme manages Models`,
            note: `Acme manages this. You can look; changes go through your organisation's admin.`,
            line: `Changes here go through your organisation's admin.`,
        });
    });

    it(`reads a guest's door and a fenced folder as not shared`, () => {
        expect(accessWords({ kind: `guest` }, { place: `Workspace` }).title).toBe(`Workspace isn't shared with you`);
        expect(accessWords({ kind: `area` }).title).toBe(`This folder isn't shared with you`);
        expect(accessWords({ kind: `area` }).short).toBe(`Not shared with you`);
    });

    it(`reads a floor under the collaborator's as the next tier a grant would give`, () => {
        expect(accessWords({ kind: `tier`, floor: `viewer` }).short).toBe(`Needs agent access`);
    });
});
