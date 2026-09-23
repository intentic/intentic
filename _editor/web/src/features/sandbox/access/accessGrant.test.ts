import { grantBody, grantSendable } from "./accessGrant";

describe(`grantBody`, () => {
    it(`carries areas on a guest grant like any other tier below maintainer`, () => {
        expect(grantBody(`dee@example.com`, `guest`, [`support`])).toEqual({ email: `dee@example.com`, role: `guest`, areas: [`support`] });
    });

    // Absent and empty are different grants: no field is the whole workspace, an empty list is a fence admitting
    // nothing. Sending one for the other is the difference between a colleague seeing everything and seeing nothing.
    it(`omits the fence entirely when no area is picked, and sends it when one is`, () => {
        expect(grantBody(`vic@example.com`, `viewer`, undefined)).toEqual({ email: `vic@example.com`, role: `viewer` });
        expect(grantBody(`vic@example.com`, `viewer`, [])).toEqual({ email: `vic@example.com`, role: `viewer`, areas: [] });
        expect(grantBody(`vic@example.com`, `viewer`, [`support`])).toEqual({ email: `vic@example.com`, role: `viewer`, areas: [`support`] });
    });

    // The tier carries the owner's operating authority and reads every credential; a folder fence over it would be a
    // line on a screen, and the daemon refuses one, so the body never carries it either.
    it(`drops the fence on a maintainer, whatever the picker held`, () => {
        expect(grantBody(`mai@example.com`, `maintainer`, [`support`])).toEqual({ email: `mai@example.com`, role: `maintainer` });
    });
});

describe(`grantSendable`, () => {
    // A guest reaches its assistants and nothing else, so both halves have to hold: a fence, and a fence with somebody
    // behind it. Unfenced it would speak through every card in the workspace.
    it(`holds a guest grant until its areas reach an assistant`, () => {
        expect(grantSendable(`guest`, undefined, 3)).toBe(false);
        expect(grantSendable(`guest`, [], 3)).toBe(false);
        expect(grantSendable(`guest`, [`support`], 0)).toBe(false);
        expect(grantSendable(`guest`, [`support`], 1)).toBe(true);
    });

    // An unfenced writer would be a grant to change every file in the workspace; the absent area list is exactly what
    // the daemon reads as the whole of it, so the form cannot send one either. Which assistants it reaches is not the
    // writer's question — it does work of its own.
    it(`holds a writer grant until it names an area, whatever that area reaches`, () => {
        expect(grantSendable(`writer`, undefined, 3)).toBe(false);
        expect(grantSendable(`writer`, [], 3)).toBe(false);
        expect(grantSendable(`writer`, [`support`], 0)).toBe(true);
    });

    it(`lets every other tier be granted fenced or not, reaching an assistant or not`, () => {
        expect(grantSendable(`viewer`, undefined, 0)).toBe(true);
        expect(grantSendable(`collaborator`, [`support`], 0)).toBe(true);
        expect(grantSendable(`maintainer`, undefined, 0)).toBe(true);
    });
});
