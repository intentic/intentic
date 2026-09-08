// @vitest-environment jsdom
// Every sign-in surface (login, sandbox gate, desktop hand-off) crossed with both windows (ordinary browser,
// desktop webview), where Google's button renders and accepts clicks but does nothing. The rule lives in
// useGoogleIdentity; add a new surface to `SURFACES` below to hold it to the same rule.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Mounting reads matchMedia (ui) and window.env (environment.ts) at module scope; see Setup.test.ts.

vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () => ({ query: { state: `nonce`, challenge: `chal` }, params: {} }) as never,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) as never,
}));

// renderButton mimics the real mechanism (false in the desktop window, true elsewhere), since what's under test is
// each surface's response to that. The mechanism's own half is asserted in useGoogleIdentity.desktop.test.ts.
const desktopVersion = vi.fn<() => string | undefined>();
const signInThroughBrowser = vi.fn();
vi.mock(`../../app/environments/desktop`, () => ({
    DESKTOP_SIGN_IN_LINK: `intentic://signin`,
    DESKTOP_DOWNLOADS: {},
    desktopVersion: () => desktopVersion(),
    // Which build this machine could install; irrelevant here, so it always answers none.
    desktopInstaller: () => undefined,
    desktopSetupLink: () => ``,
    openDesktopLink: vi.fn(),
    signInThroughBrowser: () => signInThroughBrowser(),
}));

const renderButton = vi.fn<() => Promise<boolean>>();
const needsSignIn = ref(true);
vi.mock(`./useGoogleIdentity`, () => ({
    useGoogleIdentity: () => ({
        needsSignIn,
        renderButton,
        cancelSignIn: vi.fn(),
        getIdToken: vi.fn(() => new Promise<never>(() => {})),
        adoptIdToken: vi.fn(),
    }),
}));
vi.mock(`./useAuth`, () => ({
    useAuth: () => ({ user: ref({ email: `owner@example.com` }), signInWithGoogle: vi.fn(), signInWithGoogleCredential: vi.fn() }),
}));
vi.mock(`../sandbox/client/useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId: ref(undefined) }) }));
vi.mock(`../../lib/useApi`, () => ({ apiClient: { desktop: { handoff: vi.fn() } } }));

const { default: Login } = await import("./Login.vue");
const { default: DesktopAuth } = await import("./DesktopAuth.vue");
const { default: GoogleSigninGate } = await import("../sandbox/gates/GoogleSigninGate.vue");

// Membership rule: any surface that can put a sign-in in front of someone, not just ones that import Google (which
// would miss the gate).
const SURFACES = [
    { name: `the login screen`, component: Login },
    { name: `the workspace's sandbox gate`, component: GoogleSigninGate },
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
