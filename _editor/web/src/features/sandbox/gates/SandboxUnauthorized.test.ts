// The no-access gate's one button, which is a sign-in surface even though it shows no Google button: what
// "Switch Google account" has to mean on each of the two windows. It meant neither before — the app's window raised a
// second dialog in front of the browser hand-off, and the browser re-asked Google, which answered with the account
// already approved there. Both roads landed back on this screen with the same two addresses on it.
import "@intentic/testing/dom";
import { it, expect, beforeEach, afterEach, mock } from "bun:test";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Needs jsdom: ui reads matchMedia at module scope, and environment.ts reads window.env and throws without it.

const clearCredential = mock();
const getIdToken = mock<(options?: { pick?: boolean }) => Promise<string | undefined>>();
mock.module(`../../auth/useGoogleIdentity`, () => ({
    useGoogleIdentity: () => ({ clearCredential, getIdToken: (options?: { pick?: boolean }) => getIdToken(options) }),
}));
mock.module(`../../auth/useAuth`, () => ({ useAuth: () => ({ user: ref({ email: `owner@example.com` }) }) }));

const invalidateSession = mock();
const getSessionToken = mock<() => Promise<unknown>>();
mock.module(`../session/sandboxSession`, () => ({
    useSandboxSession: () => ({ presentedEmail: ref(`someone.else@example.com`), invalidateSession, getSessionToken }),
}));
mock.module(`../client/useSandbox`, () => ({ useSandbox: () => ({ active: ref({ name: `workspace`, role: `owner` }) }) }));

const signInThroughBrowser = mock<(options?: { pickAccount?: boolean }) => void>();
const desktopVersion = mock<() => string | undefined>();
mock.module(`../../../app/environments/desktop`, () => ({
    DESKTOP_SIGN_IN_LINK: `intentic://signin`,
    desktopVersion: () => desktopVersion(),
    openDesktopLink: mock(),
    signInThroughBrowser: (options?: { pickAccount?: boolean }) => signInThroughBrowser(options),
}));

const { default: SandboxUnauthorized } = await import("./SandboxUnauthorized.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxUnauthorized) });
    app.component(`Icon`, IconStub);
    app.mount(el);
    await nextTick();
    return el;
};

const press = async (el: HTMLElement): Promise<void> => {
    el.querySelector(`button`)?.click();
    await nextTick();
    await nextTick();
};

beforeEach(() => {
    clearCredential.mockReset();
    invalidateSession.mockReset();
    getSessionToken.mockReset().mockResolvedValue(undefined);
    getIdToken.mockReset().mockResolvedValue(`fresh-id-token`);
    signInThroughBrowser.mockReset();
    desktopVersion.mockReset();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`asks Google for its chooser rather than the account it would pick on its own`, async () => {
    const el = await mount();

    await press(el);

    expect(clearCredential).toHaveBeenCalledTimes(1);
    expect(invalidateSession).toHaveBeenCalledTimes(1);
    // THE BUG: without this, Google re-answers with the account that was just refused and nothing on screen changes.
    expect(getIdToken).toHaveBeenCalledWith({ pick: true });
    expect(getSessionToken).toHaveBeenCalledTimes(1);
});

it(`leaves the session alone when the chooser is dismissed`, async () => {
    getIdToken.mockResolvedValue(undefined);
    const el = await mount();

    await press(el);

    expect(getSessionToken).not.toHaveBeenCalled();
});

it(`hands the app's own window straight to the browser, asking for the chooser there`, async () => {
    desktopVersion.mockReturnValue(`1.2.3`);
    const el = await mount();

    await press(el);

    // No Google mint in this window: it cannot ask, and the gate it used to raise was a second dialog on one road.
    expect(getIdToken).not.toHaveBeenCalled();
    expect(signInThroughBrowser).toHaveBeenCalledWith({ pickAccount: true });
});
