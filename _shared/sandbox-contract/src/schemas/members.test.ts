import { accessRefusal, holdsRight, landsHere, memberAccess, peopleChangeRefusal, tierOf } from "./members.js";

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

// Home only: a guest whose one conversation is its home, and whose home lands by itself exactly when they may land it.
describe(`home-only access`, () => {
    it(`is a guest that edits nothing and needs no area, carrying its answer to landing`, () => {
        expect(memberAccess({ role: `guest`, agents: `home` })).toEqual({ manage: false, agents: `home`, see: undefined, edit: `none` });
        expect(memberAccess({ role: `guest`, agents: `home`, edit: `all`, lands: true })).toEqual({
            manage: false,
            agents: `home`,
            see: undefined,
            edit: `none`,
            lands: true,
        });
        expect(tierOf({ manage: false, agents: `home`, see: undefined, edit: `none` })).toBe(`guest`);
        expect(accessRefusal({ manage: false, agents: `home`, see: undefined, edit: `none`, lands: true })).toBeUndefined();
    });

    it(`refuses landing on anyone but a home-only person, and editing on one`, () => {
        expect(accessRefusal({ manage: false, agents: `run`, see: undefined, edit: `none`, lands: true })).toMatch(/home-only/);
        expect(accessRefusal({ manage: false, agents: `home`, see: undefined, edit: [`web`] })).toMatch(/changes nothing by hand/);
    });

    it(`gives one answer to whether work lands by itself and whether they may land it`, () => {
        expect(landsHere({ manage: true, agents: `run` })).toBe(true);
        expect(landsHere({ manage: false, agents: `home`, lands: true })).toBe(true);
        expect(landsHere({ manage: false, agents: `home` })).toBe(false);
        expect(landsHere({ manage: false, agents: `run`, lands: true })).toBe(false);
    });
});

describe(`rights`, () => {
    test(`the owner and Full access run every part; anyone else what their row names`, () => {
        expect(holdsRight({ role: `owner` }, `people`)).toBe(true);
        expect(holdsRight({ role: `maintainer` }, `secrets`)).toBe(true);
        expect(holdsRight({ role: `collaborator`, manages: [`people`] }, `people`)).toBe(true);
        expect(holdsRight({ role: `collaborator`, manages: [`people`] }, `secrets`)).toBe(false);
        expect(holdsRight({ role: `writer` }, `privacy`)).toBe(false);
    });

    test(`a row's rights ride on its access, and never make a tier`, () => {
        const access = memberAccess({ role: `collaborator`, agents: `run`, manages: [`people`, `ownAccounts`] });
        expect(access.manages).toEqual([`people`, `ownAccounts`]);
        expect(tierOf(access)).toBe(`collaborator`);
        expect(memberAccess({ role: `collaborator`, agents: `run`, manages: [] }).manages).toBeUndefined();
    });

    test(`someone who only chats or works through their home holds none`, () => {
        expect(accessRefusal({ manage: false, agents: `chat`, see: [`docs`], edit: `none`, manages: [`people`] })).toContain(`holds no rights`);
        expect(accessRefusal({ manage: false, agents: `home`, see: undefined, edit: `none`, manages: [`secrets`] })).toContain(`holds no rights`);
        expect(accessRefusal({ manage: false, agents: `off`, see: undefined, edit: `none`, manages: [`people`] })).toBeUndefined();
    });
});

describe(`peopleChangeRefusal`, () => {
    const lead = { email: `lead@example.com`, role: `collaborator` as const, manages: [`people` as const, `ownAccounts` as const] };

    test(`the owner and Full access change anyone, themselves included`, () => {
        expect(peopleChangeRefusal({ email: `o@example.com`, role: `owner` }, { email: `x@example.com`, after: { role: `maintainer` } })).toBeUndefined();
        const full = { email: `m@example.com`, role: `maintainer` as const };
        expect(peopleChangeRefusal(full, { email: `m@example.com`, before: { role: `maintainer` }, after: { role: `collaborator` } })).toBeUndefined();
        expect(peopleChangeRefusal(full, { email: `x@example.com`, before: { role: `maintainer` } })).toBeUndefined();
    });

    test(`People & access changes anyone below Full access but its holder`, () => {
        expect(peopleChangeRefusal(lead, { email: `new@example.com`, after: { role: `writer` } })).toBeUndefined();
        expect(peopleChangeRefusal(lead, { email: `x@example.com`, before: { role: `viewer` } })).toBeUndefined();
        expect(peopleChangeRefusal(lead, { email: `LEAD@example.com`, before: { role: `collaborator` }, after: { role: `writer` } })).toContain(`your own access`);
        expect(peopleChangeRefusal(lead, { email: `x@example.com`, after: { role: `maintainer` } })).toContain(`Full access is granted`);
        expect(peopleChangeRefusal(lead, { email: `x@example.com`, before: { role: `maintainer` } })).toContain(`Full access person`);
        expect(peopleChangeRefusal({ ...lead, manages: [] }, { email: `x@example.com`, after: { role: `viewer` } })).toContain(`People & access`);
    });

    test(`it hands out only the rights its holder has, and leaves the ones already held alone`, () => {
        expect(peopleChangeRefusal(lead, { email: `x@example.com`, after: { role: `viewer`, manages: [`people`, `ownAccounts`] } })).toBeUndefined();
        expect(peopleChangeRefusal(lead, { email: `x@example.com`, after: { role: `viewer`, manages: [`secrets`] } })).toContain(`secrets`);
        expect(
            peopleChangeRefusal(lead, { email: `x@example.com`, before: { role: `viewer`, manages: [`secrets`] }, after: { role: `writer`, manages: [`secrets`] } }),
        ).toBeUndefined();
        expect(peopleChangeRefusal(lead, { email: `x@example.com`, before: { role: `viewer`, manages: [`secrets`] }, after: { role: `writer` } })).toBeUndefined();
    });
});
