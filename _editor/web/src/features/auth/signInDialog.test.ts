// The desktop app's workspace asks for a sign-in over the view on screen, never instead of it: /login becomes the dialog,
// the view stays, and the browser's hand-off coming back is taken there. A browser keeps its /login.
import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";
import type { NoticeModel } from "@intentic/ui";
import { noticeOf } from "@intentic/ui/async";
import { ref } from "vue";
import type { LocationQuery } from "vue-router";

let inApp = true;
jest.mock(`../../app/environments/desktopWorkspace`, () => ({ desktopWorkspace: () => inApp }));
const tellSignedInOnThisComputer = jest.fn();
jest.mock(`../../app/environments/desktop`, () => ({ tellSignedInOnThisComputer: () => tellSignedInOnThisComputer(), signInThroughBrowser: jest.fn() }));
const user = ref<{ id: string } | null>(null);
jest.mock(`../../client/auth/useAuth`, () => ({ useAuth: () => ({ user }) }));

// The redemption itself is redeemHandoff.ts's (and DesktopAuthComplete.test.ts's); here it signs in as `signsInAs`, or
// answers the refusal it is given.
let signsInAs = `acct-1`;
let refusal: NoticeModel | undefined;
jest.mock(`./redeemHandoff`, () => ({
    readDesktopHandoff: (query: LocationQuery) =>
        query[`handoff`] === undefined ? undefined : { handoff: `row-1`, verifier: `v`, backToFolder: query[`back`] === `agent` },
    redeemDesktopHandoff: async () => {
        if (refusal === undefined) {
            user.value = { id: signsInAs };
        }
        return refusal;
    },
}));

type Dialog = typeof import("./signInDialog");
type Handoff = typeof import("./browserHandoff");

const enter = jest.fn(async (_destination: string) => undefined);
const reload = jest.fn((_destination: string) => undefined);

// Each case gets the module afresh: what it holds (the ask, whether this page lost an account) is the page's own.
const load = async (): Promise<Dialog & Handoff> => {
    const dialog = await freshImport<Dialog>(`./signInDialog.ts`, import.meta.url);
    dialog.hostSignIn({ enter, reload });
    const handoff = await import(`./browserHandoff`);
    return { ...dialog, ...handoff };
};

const shellRoute = (fullPath: string) => ({ fullPath, matched: [{ path: `/` }] });
const outsideRoute = (fullPath: string) => ({ fullPath, matched: [{ path: fullPath }] });
const login = (query: LocationQuery = {}) => ({ name: `login`, query });
const completion = (query: LocationQuery) => ({ name: `desktop-auth-complete`, query });
const settled = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => {
    inApp = true;
    user.value = null;
    signsInAs = `acct-1`;
    refusal = undefined;
    enter.mockClear();
    reload.mockClear();
    tellSignedInOnThisComputer.mockClear();
    sessionStorage.clear();
});

describe(`a sign-in asked for in the desktop app's workspace`, () => {
    it(`leaves a browser on /login`, async () => {
        inApp = false;
        const { signInInPlace, signInAsk } = await load();
        expect(signInInPlace(login({ returnTo: `/agents` }), shellRoute(`/home`))).toBe(true);
        expect(signInAsk.value).toBeUndefined();
    });

    it(`keeps the view on screen and asks over it, returning to that same view`, async () => {
        const { signInInPlace, signInAsk } = await load();
        expect(signInInPlace(login(), shellRoute(`/home`))).toBe(false);
        expect(signInAsk.value).toEqual({ returnTo: `/home`, reason: `asked`, stage: { kind: `choose` } });
    });

    it(`says it is for what the reader was heading to, when that is somewhere else`, async () => {
        const { signInInPlace, signInAsk } = await load();
        expect(signInInPlace(login({ returnTo: `/home?add=sandbox` }), shellRoute(`/home`))).toBe(false);
        expect(signInAsk.value).toMatchObject({ returnTo: `/home?add=sandbox`, reason: `needed` });
    });

    // Nothing is on screen yet at a cold start (or only a screen standing outside the shell): Home's first run is the view
    // the dialog comes up over, never a sign-in screen of its own.
    it(`comes up over Home when there is no view to stay on`, async () => {
        const { signInInPlace, signInAsk } = await load();
        expect(signInInPlace(login({ returnTo: `/agents` }), undefined)).toBe(`/home`);
        expect(signInAsk.value).toMatchObject({ returnTo: `/agents`, reason: `needed` });
        expect(signInInPlace(login(), outsideRoute(`/platform-unavailable`))).toBe(`/home`);
    });

    it(`goes nowhere off this app once signed in`, async () => {
        const { signInInPlace, signInAsk } = await load();
        signInInPlace(login({ returnTo: `//evil.example` }), shellRoute(`/home`));
        expect(signInAsk.value?.returnTo).toBe(`/`);
    });

    it(`lets every other navigation through`, async () => {
        const { signInInPlace } = await load();
        expect(signInInPlace({ name: `agents`, query: {} }, shellRoute(`/home`))).toBe(true);
    });

    it(`goes on to where it was going once the emailed code signs in, in place`, async () => {
        const { askSignIn, signedIn, signInAsk } = await load();
        askSignIn(`/home?add=sandbox`, `needed`);
        await signedIn(`/home?add=sandbox`);
        expect(enter).toHaveBeenCalledWith(`/home?add=sandbox`);
        expect(reload).not.toHaveBeenCalled();
        expect(signInAsk.value).toBeUndefined();
    });

    // HostedStart's "switch account" puts a signed-in reader here: the page holds the first account's state.
    it(`enters afresh when the emailed code signs in another account than the page held`, async () => {
        user.value = { id: `acct-1` };
        const { askSignIn, signedIn } = await load();
        askSignIn(`/start/hosted`, `needed`);
        user.value = { id: `acct-2` };
        await signedIn(`/start/hosted`);
        expect(reload).toHaveBeenCalledWith(`/start/hosted`);
        expect(enter).not.toHaveBeenCalled();
    });

    it(`closes on Not now and leaves the reader where they are`, async () => {
        const { askSignIn, dismissSignIn, signInAsk, useBrowserHandoff } = await load();
        askSignIn(`/home`, `asked`);
        useBrowserHandoff().start(`/home`);
        dismissSignIn();
        expect(signInAsk.value).toBeUndefined();
        expect(useBrowserHandoff().waiting.value).toBe(false);
        expect(reload).not.toHaveBeenCalled();
    });
});

describe(`a session that ends under the page`, () => {
    it(`keeps the lapse said when something else asks meanwhile`, async () => {
        const { askSignIn, signInAsk } = await load();
        askSignIn(`/agents`, `lapsed`);
        askSignIn(`/home`, `asked`);
        expect(signInAsk.value).toMatchObject({ returnTo: `/home`, reason: `lapsed` });
    });

    // The page kept the lost account's state while it was gone: it is entered afresh at the view it was on.
    it(`enters the view again by a fresh load once signed back in`, async () => {
        const { askSignIn, signedIn } = await load();
        askSignIn(`/agents`, `lapsed`);
        await signedIn(`/agents`);
        expect(reload).toHaveBeenCalledWith(`/agents`);
        expect(enter).not.toHaveBeenCalled();
    });

    it(`leaves the lost account's view for Home's first run on Not now`, async () => {
        const { askSignIn, dismissSignIn } = await load();
        askSignIn(`/agents`, `lapsed`);
        dismissSignIn();
        expect(reload).toHaveBeenCalledWith(`/home`);
    });
});

describe(`the browser's hand-off coming back`, () => {
    const handoff = { handoff: `row-1`, verifier: `v`.repeat(43) };

    it(`is taken over the view on screen, and goes on to where the dialog was going`, async () => {
        const { askSignIn, signInInPlace, signInAsk, useBrowserHandoff } = await load();
        askSignIn(`/home?add=sandbox`, `needed`);
        useBrowserHandoff().start(`/home?add=sandbox`);
        expect(signInInPlace(completion(handoff), shellRoute(`/home`))).toBe(false);
        expect(signInAsk.value?.stage).toEqual({ kind: `arriving` });
        await settled();
        expect(enter).toHaveBeenCalledWith(`/home?add=sandbox`);
        expect(signInAsk.value).toBeUndefined();
        expect(useBrowserHandoff().waiting.value).toBe(false);
    });

    it(`is left to its own screen in a page with nothing on it yet`, async () => {
        const { signInInPlace, signInAsk } = await load();
        expect(signInInPlace(completion(handoff), undefined)).toBe(true);
        expect(signInAsk.value).toBeUndefined();
    });

    it(`says why a refused one did not sign in, and offers the ways in again`, async () => {
        refusal = noticeOf(`That sign-in had already expired.`);
        const { askSignIn, signInInPlace, signInAsk } = await load();
        askSignIn(`/home`, `asked`);
        signInInPlace(completion(handoff), shellRoute(`/home`));
        await settled();
        expect(signInAsk.value?.stage).toEqual({ kind: `choose`, notice: refusal });
        expect(enter).not.toHaveBeenCalled();
    });

    // Begun on This computer, redeemed out of sight: the app hears it is done, and this page stays on the view it shows.
    it(`tells the app a sign-in begun on This computer is done, and moves nobody`, async () => {
        const { signInInPlace } = await load();
        signInInPlace(completion({ ...handoff, back: `agent` }), shellRoute(`/agents`));
        await settled();
        expect(tellSignedInOnThisComputer).toHaveBeenCalledTimes(1);
        expect(enter).toHaveBeenCalledWith(`/agents`);
    });

    // A sandbox's own sign-in wall sent the reader to the browser for a Google proof: the account is the same, the wall's
    // wait takes the proof, and nothing moves.
    it(`changes nothing on screen when it only renews the account already signed in`, async () => {
        user.value = { id: `acct-1` };
        const { signInInPlace, signInAsk } = await load();
        signInInPlace(completion(handoff), shellRoute(`/agents`));
        expect(signInAsk.value).toBeUndefined();
        await settled();
        expect(signInAsk.value).toBeUndefined();
        expect(enter).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
    });

    it(`enters afresh when it signs in another account than the page held`, async () => {
        user.value = { id: `acct-1` };
        signsInAs = `acct-2`;
        const { signInInPlace } = await load();
        sessionStorage.clear();
        signInInPlace(completion(handoff), shellRoute(`/agents`));
        await settled();
        expect(reload).toHaveBeenCalledWith(`/`);
    });
});
