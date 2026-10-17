import { type AccessDraft, accessWord, draftGrant, draftOf, draftProblem, emailSignInByDefault, newPerson } from "./accessGrant";

const draft = (over: Partial<AccessDraft> = {}): AccessDraft => ({ ...newPerson(`ana@corp.example`), ...over });

describe(`newPerson`, () => {
    // Read-only, no agents, nothing to spend: the invite can go out at once without handing over anything undecided.
    it(`starts able to see and nothing more`, () => {
        expect(newPerson(`ana@corp.example`)).toEqual({
            manage: false,
            agents: `off`,
            see: undefined,
            edit: `none`,
            emailSignIn: true,
            credentials: { capabilities: [], secrets: [] },
        });
    });
});

describe(`draftGrant`, () => {
    // The role sent is the tier the answers make, and the answers ride beside it so the row says what was decided.
    it(`sends the tier the access makes, with every answer that makes it`, () => {
        expect(draftGrant(`ana@corp.example`, draft())).toEqual({
            email: `ana@corp.example`,
            role: `viewer`,
            agents: `off`,
            emailSignIn: true,
            credentials: { capabilities: [], secrets: [] },
        });
        expect(draftGrant(`ana@corp.example`, draft({ agents: `off`, see: [`web`, `support`], edit: [`support`], credentials: `all` }))).toEqual({
            email: `ana@corp.example`,
            role: `writer`,
            agents: `off`,
            areas: [`web`, `support`],
            edit: [`support`],
            emailSignIn: true,
            credentials: `all`,
        });
    });

    // Managing is every other answer at once, and the daemon refuses a fence or a list of credentials on it.
    it(`sends a manager's tier and sign-in alone`, () => {
        expect(draftGrant(`mai@example.com`, draft({ manage: true, see: [`web`], credentials: { capabilities: [`github`], secrets: [] } }))).toEqual({
            email: `mai@example.com`,
            role: `maintainer`,
            emailSignIn: true,
        });
    });
});

describe(`draftOf`, () => {
    // A row from before agents and edit reads as its role meant, and a person the daemon never wrote as the platform's tier.
    it(`reads what the daemon holds, else the platform's tier`, () => {
        expect(draftOf({ email: `w@x.example`, role: `writer`, areas: [`web`] }, `writer`)).toMatchObject({ agents: `run`, see: [`web`], edit: [`web`], credentials: `all` });
        expect(draftOf(undefined, `collaborator`)).toMatchObject({ agents: `run`, see: undefined, edit: `none`, emailSignIn: false });
    });
});

describe(`draftProblem`, () => {
    it(`holds a chat until its areas reach an assistant`, () => {
        expect(draftProblem(draft({ agents: `chat`, see: [] }), 0)).toBe(`chatNeedsArea`);
        expect(draftProblem(draft({ agents: `chat`, see: [`finance`] }), 0)).toBe(`chatReachesNobody`);
        expect(draftProblem(draft({ agents: `chat`, see: [`support`] }), 1)).toBeUndefined();
    });

    // A narrowed scope with nothing ticked is a fence admitting nothing, which nobody means by pressing it.
    it(`holds a narrowed scope until something is ticked`, () => {
        expect(draftProblem(draft({ see: [] }), 0)).toBe(`pickSeeArea`);
        expect(draftProblem(draft({ edit: [] }), 0)).toBe(`pickEditArea`);
        expect(draftProblem(draft({ see: [`web`], edit: [`finance`] }), 0)).toBe(`editOutsideSee`);
        expect(draftProblem(draft({ see: [`web`], edit: [`web`] }), 0)).toBeUndefined();
        expect(draftProblem(draft({ manage: true, see: [] }), 0)).toBeUndefined();
    });
});

describe(`accessWord`, () => {
    it(`names a person by what they can do`, () => {
        expect(accessWord(draft())).toBe(`sees`);
        expect(accessWord(draft({ agents: `run` }))).toBe(`runsAgents`);
        expect(accessWord(draft({ agents: `off`, edit: [`web`] }))).toBe(`edits`);
        expect(accessWord(draft({ agents: `chat`, see: [`support`] }))).toBe(`chats`);
        expect(accessWord(draft({ manage: true }))).toBe(`manages`);
    });
});

describe(`emailSignInByDefault`, () => {
    // Built from parts, the way a reader types them: an address at Google's own domains, or at any other.
    const at = (domain: string): string => [`ana`, domain].join(`@`);

    // Google already vouches for its own addresses; a second road for them is one the owner did not ask for.
    it(`is on for any address but the two Google holds`, () => {
        expect(emailSignInByDefault(at(`corp.example`))).toBe(true);
        expect(emailSignInByDefault(at(`gmail.com.example`))).toBe(true);
        expect(emailSignInByDefault(at(`gmail.com`))).toBe(false);
        expect(emailSignInByDefault(` ${at(`GoogleMail.com`)} `)).toBe(false);
    });
});
