import { accessRefusal, memberAccess, tierOf } from "./members.js";

// A person's access is three answers, and the tier is what they add up to; a row from before the answers reads as its
// role meant, so nobody's access moves when the daemon learns the new fields.

describe(`memberAccess`, () => {
    it(`reads a row written before agents and edit as its role meant`, () => {
        expect(memberAccess({ role: `guest`, areas: [`support`] })).toEqual({ manage: false, agents: `chat`, see: [`support`], edit: `none` });
        expect(memberAccess({ role: `viewer` })).toEqual({ manage: false, agents: `off`, see: undefined, edit: `none` });
        expect(memberAccess({ role: `collaborator`, areas: [`web`] })).toEqual({ manage: false, agents: `run`, see: [`web`], edit: `none` });
        expect(memberAccess({ role: `writer`, areas: [`web`] })).toEqual({ manage: false, agents: `run`, see: [`web`], edit: [`web`] });
        expect(memberAccess({ role: `maintainer`, areas: [`web`] })).toEqual({ manage: true, agents: `run`, see: undefined, edit: `all` });
    });

    it(`takes what a row says when it says it, and never lets a chat edit`, () => {
        expect(memberAccess({ role: `writer`, agents: `off`, edit: [`web`] })).toEqual({ manage: false, agents: `off`, see: undefined, edit: [`web`] });
        expect(memberAccess({ role: `guest`, agents: `chat`, areas: [`support`], edit: `all` }).edit).toBe(`none`);
    });
});

describe(`tierOf`, () => {
    it(`names the tier the answers add up to`, () => {
        expect(tierOf({ manage: true, agents: `run`, see: undefined, edit: `all` })).toBe(`maintainer`);
        expect(tierOf({ manage: false, agents: `chat`, see: [`support`], edit: `none` })).toBe(`guest`);
        expect(tierOf({ manage: false, agents: `off`, see: undefined, edit: [`web`] })).toBe(`writer`);
        expect(tierOf({ manage: false, agents: `run`, see: undefined, edit: `none` })).toBe(`collaborator`);
        expect(tierOf({ manage: false, agents: `off`, see: [`web`], edit: `none` })).toBe(`viewer`);
    });
});

describe(`accessRefusal`, () => {
    const access = (over: Partial<Parameters<typeof tierOf>[0]>) => ({ manage: false, agents: `run` as const, see: undefined, edit: `none` as const, ...over });

    it(`asks a chat for the areas whose assistants it talks to`, () => {
        expect(accessRefusal(access({ agents: `chat` }))).toContain(`at least one area`);
        expect(accessRefusal(access({ agents: `chat`, see: [`support`] }))).toBeUndefined();
    });

    // Editing reaches only where they can look: everything needs the whole workspace, and each area named must be seen.
    it(`keeps editing inside what they see`, () => {
        expect(accessRefusal(access({ see: [`web`], edit: `all` }))).toContain(`whole workspace`);
        expect(accessRefusal(access({ edit: `all` }))).toBeUndefined();
        expect(accessRefusal(access({ see: [`web`], edit: [`web`, `finance`] }))).toContain(`finance`);
        expect(accessRefusal(access({ edit: [`web`] }))).toBeUndefined();
        expect(accessRefusal(access({ edit: [] }))).toContain(`at least one area`);
    });
});
