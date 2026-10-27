import { wantOf } from "../accessRequest";

// What an "Ask for access" press asks the owner for, read off the refusal it stands under, and when there is nothing a
// grant could change: the owner's own tier is nobody's to give, and an organisation's lock is its admin's to lift.

describe(`wantOf`, () => {
    it(`asks for the tier a route wanted`, () => {
        expect(wantOf({ kind: `tier`, floor: `maintainer` })).toBe(`maintainer`);
        expect(wantOf({ kind: `tier`, floor: `writer` })).toBe(`writer`);
        expect(wantOf({ kind: `tier`, floor: `collaborator` })).toBe(`collaborator`);
        expect(wantOf({ kind: `tier`, floor: `viewer` })).toBe(`viewer`);
    });

    it(`asks to run agents, to see the workspace, or for folders, by what stood in the way`, () => {
        expect(wantOf({ kind: `agents-off` })).toBe(`agents`);
        expect(wantOf({ kind: `guest` })).toBe(`viewer`);
        expect(wantOf({ kind: `area` })).toBe(`areas`);
    });

    it(`asks for nothing a grant could not give`, () => {
        expect(wantOf({ kind: `tier`, floor: `owner` })).toBeUndefined();
        expect(wantOf({ kind: `org`, org: `Acme`, section: `models` })).toBeUndefined();
    });
});
