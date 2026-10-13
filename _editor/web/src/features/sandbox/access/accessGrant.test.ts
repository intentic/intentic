import { draftGrant, emailSignInByDefault, grantBody, grantSendable, toggledReach } from "./accessGrant";

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

describe(`grantBody's email sign-in`, () => {
    // Absent is "keep what the row says" at the daemon: a re-grade from this form must not send it, or it would decide
    // a person's way in as a side effect of their tier.
    it(`sends the switch only when the caller decides it, either way`, () => {
        expect(grantBody(`ana@corp.example`, `viewer`, undefined)).toEqual({ email: `ana@corp.example`, role: `viewer` });
        expect(grantBody(`ana@corp.example`, `viewer`, undefined, true)).toEqual({ email: `ana@corp.example`, role: `viewer`, emailSignIn: true });
        expect(grantBody(`ana@corp.example`, `viewer`, undefined, false)).toEqual({ email: `ana@corp.example`, role: `viewer`, emailSignIn: false });
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

describe(`grantBody's credential reach`, () => {
    const reach = { capabilities: [`github`], secrets: [`DATABASE_URL`] };

    // Absent keeps the row's reach at the daemon, so only a caller that decided it may send it; `all` lifts one.
    it(`sends a reach or its lifting only when the caller decides it`, () => {
        expect(grantBody(`ana@corp.example`, `collaborator`, undefined)).toEqual({ email: `ana@corp.example`, role: `collaborator` });
        expect(grantBody(`ana@corp.example`, `collaborator`, undefined, undefined, reach)).toEqual({
            email: `ana@corp.example`,
            role: `collaborator`,
            credentials: reach,
        });
        expect(grantBody(`ana@corp.example`, `guest`, [`support`], undefined, `all`)).toEqual({
            email: `ana@corp.example`,
            role: `guest`,
            areas: [`support`],
            credentials: `all`,
        });
    });

    // A maintainer reads every credential and the daemon refuses it a list; a viewer runs no assistant, so its row keeps
    // whatever it held for the day it is graded up.
    it(`never sends one for a maintainer or a viewer`, () => {
        expect(grantBody(`mai@example.com`, `maintainer`, undefined, undefined, reach)).toEqual({ email: `mai@example.com`, role: `maintainer` });
        expect(grantBody(`vic@example.com`, `viewer`, undefined, undefined, reach)).toEqual({ email: `vic@example.com`, role: `viewer` });
    });

    it(`sends the dialog's whole draft as one grant`, () => {
        expect(draftGrant(`ana@corp.example`, { role: `writer`, areas: [`support`], emailSignIn: true, credentials: reach })).toEqual({
            email: `ana@corp.example`,
            role: `writer`,
            areas: [`support`],
            emailSignIn: true,
            credentials: reach,
        });
    });
});

describe(`toggledReach`, () => {
    it(`adds a subject once and takes it off again, leaving the other kind alone`, () => {
        const start = { capabilities: [`github`], secrets: [`DATABASE_URL`] };
        expect(toggledReach(start, `capabilities`, `fly`, true)).toEqual({ capabilities: [`github`, `fly`], secrets: [`DATABASE_URL`] });
        expect(toggledReach(start, `capabilities`, `github`, true)).toEqual(start);
        expect(toggledReach(start, `secrets`, `DATABASE_URL`, false)).toEqual({ capabilities: [`github`], secrets: [] });
    });
});
