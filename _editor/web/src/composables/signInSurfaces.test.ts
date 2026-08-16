// @vitest-environment jsdom
//
// EVERY SIGN-IN SURFACE, IN BOTH WINDOWS IT CAN BE OPENED IN — the one table this app did not have, and the
// absence of which shipped a screen that could not be got past.
//
// There are three surfaces (the login screen, the workspace's sandbox gate, the desktop hand-off page) and
// two windows (an ordinary browser, and the desktop app's embedded webview). Google refuses OAuth from an
// embedded webview and Identity Services is FedCM-based, which that webview does not implement — so Google's
// button RENDERS there, ACCEPTS CLICKS, and does nothing whatsoever. Each surface answered that separately.
// Two answered it right, one did not, and the one that did not was the screen between a fresh install and a
// working workspace.
//
// The rule now lives in the mechanism (useGoogleIdentity refuses to render in that window) and this is the
// table that holds every surface to it. A fourth surface added later belongs in `SURFACES` below; what it
// costs to add is one line, and what it buys is never shipping that dead end again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// The import-time globals a mounted view needs (see Setup.test.ts): ui reads matchMedia at module scope, and
// environment.ts reads window.env and throws without it.
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
});

vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () => ({ query: { state: `nonce`, challenge: `chal` }, params: {} }) as never,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) as never,
}));

/* The real mechanism, with only its edges faked. `renderButton` answers the way the real one does — false in
 * the desktop window, true elsewhere — because THAT is the behaviour under test here: what each surface does
 * with the refusal. The mechanism's own half of the rule is asserted in useGoogleIdentity.desktop.test.ts. */
const desktopVersion = vi.fn<() => string | undefined>();
const signInThroughBrowser = vi.fn();
vi.mock(`../environments/desktop`, () => ({
    DESKTOP_SIGN_IN_LINK: `intentic://signin`,
    DESKTOP_DOWNLOADS: {},
    desktopVersion: () => desktopVersion(),
    desktopSetupLink: () => ``,
    openDesktopLink: vi.fn(),
    signInThroughBrowser: () => signInThroughBrowser(),
}));

const renderButton = vi.fn<() => Promise<boolean>>();
const needsSignIn = ref(true);
vi.mock(`../composables/useGoogleIdentity`, () => ({
    useGoogleIdentity: () => ({
        needsSignIn,
        renderButton,
        cancelSignIn: vi.fn(),
        getIdToken: vi.fn(() => new Promise<never>(() => {})),
        adoptIdToken: vi.fn(),
    }),
}));
vi.mock(`../composables/useAuth`, () => ({
    useAuth: () => ({ user: ref({ email: `owner@example.com` }), signInWithGoogle: vi.fn(), signInWithGoogleCredential: vi.fn() }),
}));
vi.mock(`../composables/sandbox/useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId: ref(undefined) }) }));
vi.mock(`../composables/useApi`, () => ({ apiClient: { desktop: { handoff: vi.fn() } } }));

const { default: Login } = await import("../pages/Login.vue");
const { default: DesktopAuth } = await import("../pages/DesktopAuth.vue");
const { default: GoogleSigninGate } = await import("../sandbox-gates/GoogleSigninGate.vue");

/* THE TABLE. A surface belongs here the moment it can put a sign-in in front of someone — that is the whole
 * membership rule, and it is deliberately not "pages that import Google", which would have missed the gate. */
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
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    app.mount(el);
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    await nextTick();
    return el;
};

// Something a person can press — the minimum a sign-in screen owes its reader. jsdom reports no layout, so
// visibility cannot be asserted here; presence and enabled-ness are what a dead end fails on anyway.
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

            // The ONE thing this window can complete. A surface that offers anything else offers a dead end,
            // however convincing its button looks.
            expect(signInThroughBrowser, `${name} never reached the browser hand-off`).toHaveBeenCalled();
        });
    }
});

describe(`in an ordinary browser`, () => {
    for (const { name, component } of SURFACES) {
        it(`${name} puts Google's own button up and never mentions the app hand-off`, async () => {
            const el = await mount(component);

            expect(renderButton, `${name} showed no Google button where one works`).toHaveBeenCalled();
            expect(signInThroughBrowser, `${name} sent an ordinary browser to the desktop app`).not.toHaveBeenCalled();
            expect(el.textContent).not.toContain(`in your browser`);
        });
    }
});
