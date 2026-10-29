import { profileAccess } from "@intentic/sandbox-contract/schemas/access-profiles";
import { type AccessDraft, accessWord, draftGrant, draftOf, draftProblem, emailSignInByDefault, newPerson, rightsFor, rightsOffered } from "./accessGrant";

const draft = (over: Partial<AccessDraft> = {}): AccessDraft => ({ ...newPerson(`ana@corp.example`), ...over });

describe(`newPerson`, () => {
    // Read-only, no agents, nothing to spend: the invite can go out at once without handing over anything undecided.
    // Every AI account, so turning agents on later runs them rather than holding them on an empty list.
    it(`starts able to see and nothing more`, () => {
        expect(newPerson(`ana@corp.example`)).toEqual({
            manage: false,
            agents: `off`,
            see: undefined,
            edit: `none`,
            emailSignIn: true,
            credentials: { capabilities: [], secrets: [] },
            aiAccounts: `all`,
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
            aiAccounts: `all`,
            manages: [],
        });
        expect(draftGrant(`ana@corp.example`, draft({ agents: `off`, see: [`web`, `support`], edit: [`support`], credentials: `all` }))).toEqual({
            email: `ana@corp.example`,
            role: `writer`,
            agents: `off`,
            areas: [`web`, `support`],
            edit: [`support`],
            emailSignIn: true,
            credentials: `all`,
            aiAccounts: `all`,
            manages: [],
        });
    });

    // The AI accounts ride as a list, so the daemon holds the person to exactly the ones ticked.
    it(`sends the AI accounts a person may run on`, () => {
        expect(draftGrant(`ana@corp.example`, draft({ agents: `run`, aiAccounts: [`claude:work`, `endpoint/gateway`] }))).toMatchObject({
            role: `collaborator`,
            aiAccounts: [`claude:work`, `endpoint/gateway`],
        });
    });

    // Managing is every other answer at once, and the daemon refuses a fence on it; what its conversations spend still
    // rides along, since someone may manage the sandbox while paying only with some of its accounts.
    it(`sends a manager's tier, sign-in and what their conversations may spend`, () => {
        expect(
            draftGrant(`mai@example.com`, draft({ manage: true, see: [`web`], credentials: { capabilities: [`github`], secrets: [] }, aiAccounts: [`claude:work`] })),
        ).toEqual({
            email: `mai@example.com`,
            role: `maintainer`,
            emailSignIn: true,
            credentials: { capabilities: [`github`], secrets: [] },
            aiAccounts: [`claude:work`],
        });
    });
});

// The parts of the sandbox a person runs besides their own work: always said below Full access, so the row holds what
// the panel shows, and never on Full access, which runs every part already.
describe(`draftGrant with rights`, () => {
    it(`sends the rights a person was given, and an empty list when none`, () => {
        expect(draftGrant(`ana@corp.example`, draft({ agents: `run`, manages: [`secrets`, `people`] }))).toMatchObject({ role: `collaborator`, manages: [`people`, `secrets`] });
        expect(draftGrant(`ana@corp.example`, draft({ agents: `run` })).manages).toEqual([]);
    });

    it(`sends no rights for Full access`, () => {
        expect(draftGrant(`mai@example.com`, draft({ manage: true, manages: [`people`] }))).not.toHaveProperty(`manages`);
    });

    // A profile never carries rights, so they ride beside it on the person's row.
    it(`sends rights beside a profile`, () => {
        const profile = { id: `engineering`, agents: `run` as const };
        expect(draftGrant(`ana@corp.example`, draft({ ...profileAccess(profile), profile: profile.id, manages: [`privacy`] }))).toEqual({
            email: `ana@corp.example`,
            role: `collaborator`,
            profile: `engineering`,
            emailSignIn: true,
            manages: [`privacy`],
        });
    });

    // A person who only chats or works through their home conversation holds no rights (the contract refuses them), and
    // AI accounts of their own mean nothing to someone whose agents never run.
    it(`drops the rights a way of working cannot carry`, () => {
        expect(draftGrant(`h@x.example`, draft({ agents: `home`, manages: [`people`] })).manages).toEqual([]);
        expect(draftGrant(`h@x.example`, draft({ agents: `chat`, see: [`support`], manages: [`secrets`] })).manages).toEqual([]);
        expect(draftGrant(`h@x.example`, draft({ agents: `off`, manages: [`ownAccounts`, `privacy`] })).manages).toEqual([`privacy`]);
        expect(rightsOffered(`run`)).toEqual([`people`, `secrets`, `privacy`, `ownAccounts`]);
        expect(rightsOffered(`off`)).toEqual([`people`, `secrets`, `privacy`]);
        expect(rightsOffered(`chat`)).toEqual([]);
        expect(rightsFor(`run`, undefined)).toEqual([]);
    });

    it(`reads a row's rights back into the draft`, () => {
        expect(draftOf({ email: `c@x.example`, role: `collaborator`, manages: [`people`] }, `collaborator`).manages).toEqual([`people`]);
        expect(draftOf({ email: `m@x.example`, role: `maintainer` }, `maintainer`).manages).toBeUndefined();
    });
});

describe(`draftGrant for a home-only person`, () => {
    // A guest's tier with no area needed, and `lands` only when on: silence is what takes it back.
    it(`sends lands only when their home lands by itself`, () => {
        expect(draftGrant(`h@x.example`, draft({ agents: `home`, lands: true }))).toMatchObject({ role: `guest`, agents: `home`, lands: true });
        expect(draftGrant(`h@x.example`, draft({ agents: `home` }))).not.toHaveProperty(`lands`);
        expect(draftGrant(`h@x.example`, draft({ agents: `run`, lands: true }))).not.toHaveProperty(`lands`);
        expect(draftProblem(draft({ agents: `home` }), 0)).toBeUndefined();
    });
});

describe(`draftOf`, () => {
    // A row from before agents and edit reads as its role meant, and a person the daemon never wrote as the platform's tier.
    it(`reads what the daemon holds, else the platform's tier`, () => {
        expect(draftOf({ email: `w@x.example`, role: `writer`, areas: [`web`] }, `writer`)).toMatchObject({
            agents: `run`,
            see: [`web`],
            edit: [`web`],
            credentials: `all`,
            aiAccounts: `all`,
        });
        expect(draftOf({ email: `c@x.example`, role: `collaborator`, aiAccounts: [`codex:me`] }, `collaborator`)).toMatchObject({ aiAccounts: [`codex:me`] });
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

    // Agents that may run on no AI account would run nothing; a person who runs none needs no account.
    it(`holds a narrowed AI account list until one is ticked, while agents run`, () => {
        expect(draftProblem(draft({ agents: `run`, aiAccounts: [] }), 0)).toBe(`pickAiAccount`);
        expect(draftProblem(draft({ agents: `off`, aiAccounts: [] }), 0)).toBeUndefined();
        expect(draftProblem(draft({ agents: `run`, aiAccounts: [`claude:work`] }), 0)).toBeUndefined();
        expect(draftProblem(draft({ manage: true, aiAccounts: [] }), 0)).toBe(`pickAiAccount`);
    });
});

describe(`accessWord`, () => {
    it(`names a person by what they can do`, () => {
        expect(accessWord(draft())).toBe(`sees`);
        expect(accessWord(draft({ agents: `run` }))).toBe(`runsAgents`);
        expect(accessWord(draft({ agents: `off`, edit: [`web`] }))).toBe(`edits`);
        expect(accessWord(draft({ agents: `chat`, see: [`support`] }))).toBe(`chats`);
        expect(accessWord(draft({ agents: `home` }))).toBe(`homeOnly`);
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


describe(`profile grants`, () => {
    it(`sends a profile id and its derived tier without competing inline answers`, () => {
        const profile = { id: `support`, agents: `chat` as const, areas: [`support`], tools: { shell: false }, assistants: [`helper`] };
        expect(draftGrant(`ana@corp.example`, draft({ ...profileAccess(profile), profile: profile.id }))).toEqual({ email: `ana@corp.example`, role: `guest`, profile: `support`, emailSignIn: true, manages: [] });
    });
    it(`keeps tools and assistants when changing an existing person's sign-in`, () => {
        const row = { email: `ana@corp.example`, role: `guest` as const, agents: `chat` as const, areas: [`support`], tools: { shell: false }, assistants: [`helper`] };
        expect(draftGrant(row.email, { ...draftOf(row, row.role), emailSignIn: true })).toMatchObject({ tools: row.tools, assistants: [`helper`], emailSignIn: true });
        expect(draftGrant(row.email, { ...draftOf({ ...row, profile: `support` }, row.role), emailSignIn: true })).toEqual({ email: row.email, role: `guest`, profile: `support`, emailSignIn: true, manages: [] });
    });
    it(`never attaches a profile to a maintainer`, () => {
        expect(draftGrant(`ana@corp.example`, draft({ manage: true, profile: `support`, credentials: `all` }))).toEqual({
            email: `ana@corp.example`,
            role: `maintainer`,
            emailSignIn: true,
            credentials: `all`,
            aiAccounts: `all`,
        });
    });
});
