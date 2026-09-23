// Every sign-in surface (login, sandbox gate, desktop hand-off) crossed with both windows (ordinary browser,
// desktop webview), where Google's button renders and accepts clicks but does nothing. The rule lives in
// useGoogleIdentity; add a new surface to `SURFACES` below to hold it to the same rule.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as actualVueRouter from "vue-router";
import * as actualDesktop from "../../app/environments/desktop";

// Mounting reads matchMedia (ui) and window.env (environment.ts) at module scope; see Setup.test.ts.

jest.mock(`vue-router`, () => ({
    ...actualVueRouter,
    useRoute: () => ({ query: { state: `nonce`, challenge: `chal` }, params: {} }) as never,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) as never,
}));

// renderButton mimics the real mechanism (false in the desktop window, true elsewhere), since what's under test is
// each surface's response to that. The mechanism's own half is asserted in useGoogleIdentity.desktop.test.ts.
const desktopVersion = jest.fn<() => string | undefined>();
// Takes the options the real one does: a surface asking for Google's chooser says so here (environments/desktop.ts).
const signInThroughBrowser = jest.fn<(options?: { pickAccount?: boolean }) => void>();
// Partial, over the real module: a surface reaches for whatever the desktop lane grows next, and a mock listing its
// exports by hand fails the link the day one is added.
jest.mock(`../../app/environments/desktop`, () => ({
    ...actualDesktop,
    DESKTOP_SIGN_IN_LINK: `intentic://signin`,
    DESKTOP_DOWNLOADS: {},
    desktopVersion: () => desktopVersion(),
    // Which build this machine could install; irrelevant here, so it always answers none.
    desktopInstaller: () => undefined,
    desktopSetupLink: () => ``,
    openDesktopLink: jest.fn(),
    signInThroughBrowser: (options?: { pickAccount?: boolean }) => signInThroughBrowser(options),
}));

const renderButton = jest.fn<() => Promise<boolean>>();
const needsSignIn = ref(true);
jest.mock(`./useGoogleIdentity`, () => ({
    useGoogleIdentity: () => ({
        needsSignIn,
        renderButton,
        cancelSignIn: jest.fn(),
        getIdToken: jest.fn(() => new Promise<never>(() => {})),
        adoptIdToken: jest.fn(),
    }),
}));
jest.mock(`./useAuth`, () => ({
    useAuth: () => ({ user: ref({ email: `owner@example.com` }), signInWithGoogle: jest.fn(), signInWithGoogleCredential: jest.fn() }),
}));
jest.mock(`../sandbox/client/useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId: ref(undefined), active: ref(undefined) }) }));
jest.mock(`../../lib/useApi`, () => ({ apiClient: { desktop: { handoff: jest.fn() } } }));

const { default: Login } = await import("./Login.vue");
const { default: DesktopAuth } = await import("./DesktopAuth.vue");
const { default: SignInWall } = await import("../sandbox/gates/SignInWall.vue");

// Membership rule: any surface that can put a sign-in in front of someone, not just ones that import Google (which
// would miss the gate).
const SURFACES = [
    { name: `the login screen`, component: Login },
    { name: `the workspace's sandbox gate`, component: SignInWall },
    { name: `the desktop hand-off page`, component: DesktopAuth },
] as const;

let app: App | undefined;
const mount = async (component: (typeof SURFACES)[number][`component`]): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(component) });
    app.component(`Icon`, IconStub);
    app.mount(el);
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    await nextTick();
    return el;
};

// The minimum a sign-in screen owes: something pressable. jsdom has no layout, so presence and enabled-ness stand
// in for visibility.
const pressable = (el: HTMLElement): HTMLButtonElement[] => [...el.querySelectorAll(`button`)].filter((button) => !button.disabled);

beforeEach(() => {
    needsSignIn.value = true;
    signInThroughBrowser.mockReset();
    desktopVersion.mockReset();
    renderButton.mockReset().mockImplementation(async () => desktopVersion() === undefined);
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

describe(`in the desktop app's own window`, () => {
    beforeEach(() => {
        desktopVersion.mockReturnValue(`1.2.3`);
    });

    for (const { name, component } of SURFACES) {
        it(`${name} offers a control that leads somewhere`, async () => {
            const el = await mount(component);

            expect(pressable(el).length, `${name} left the reader with nothing to press`).toBeGreaterThan(0);
        });

        it(`${name} hands sign-in to the real browser`, async () => {
            const el = await mount(component);
            for (const control of pressable(el)) {
                control.click();
            }
            await nextTick();

            // The one thing this window can complete; anything else is a dead end no matter how convincing the button
            // looks.
            expect(signInThroughBrowser, `${name} never reached the browser hand-off`).toHaveBeenCalledTimes(1);
        });
    }
});

describe(`in an ordinary browser`, () => {
    for (const { name, component } of SURFACES) {
        it(`${name} puts Google's own button up and never mentions the app hand-off`, async () => {
            const el = await mount(component);

            expect(renderButton, `${name} showed no Google button where one works`).toHaveBeenCalledTimes(1);
            expect(signInThroughBrowser, `${name} sent an ordinary browser to the desktop app`).not.toHaveBeenCalled();
            expect(el.textContent).not.toContain(`in your browser`);
        });
    }
});
