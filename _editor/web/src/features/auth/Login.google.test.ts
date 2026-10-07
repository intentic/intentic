// The login page against the real credential module, with Google's script stood in for: Login.test.ts holds the page to
// what the module answers, this holds the two together where a reader met them failing. On a browser without FedCM a
// press of Google's button opens a pop-up the page cannot see; one that came back with nothing, or with an answer the
// module refused, left a button that looked dead and, after a refusal, was.
import "@intentic/testing/dom";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as actualVueRouter from "vue-router";
import * as actualDesktop from "../../app/environments/desktop";

// Configured client id, overriding bun.setup.ts's empty default. Assigned, not `??=`, since the setup file already ran.
(() => {
    globalThis.window.env = {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `client-id` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
})();

const push = jest.fn();
jest.mock(`vue-router`, () => ({
    ...actualVueRouter,
    useRouter: () => ({ push, replace: jest.fn() }) as never,
    useRoute: () => ({ query: {} }) as never,
}));
const signInWithGoogle = jest.fn().mockResolvedValue(undefined);
const signInWithGoogleCredential = jest.fn().mockResolvedValue(undefined);
jest.mock(`../../client/auth/useAuth`, () => ({
    useAuth: () => ({ user: ref(null), signInWithGoogle, signInWithGoogleCredential }),
}));
// An ordinary browser: the desktop webview never shows Google's button at all (signInSurfaces.test.ts). Partial, over
// the real module, for Login.test.ts's reason.
jest.mock(`../../app/environments/desktop`, () => ({ ...actualDesktop, desktopVersion: () => undefined }));
jest.mock(`../../app/environments/desktopDownloads`, () => ({ desktopInstaller: () => undefined }));
const track = jest.fn();
jest.mock(`../../app/analytics`, () => ({ track }));

const { default: Login } = await import("./Login.vue");
const { useGoogleIdentity } = await import("../../client/auth/useGoogleIdentity");

const credential = (livesForMs: number): string => {
    const payload = { email: `owner@example.com`, exp: Math.floor((Date.now() + livesForMs) / 1000) };
    const body = btoa(JSON.stringify(payload)).replace(/\+/g, `-`).replace(/\//g, `_`).replace(/=+$/, ``);
    return `header.${body}.signature`;
};
// What a clock set an hour ahead makes of a token Google just minted: already inside the module's near-expiry guard.
const STALE = credential(30_000);
const GOOD = credential(3_600_000);

// Google's script, as much of it as the page touches: the button draws itself into the page, as Google's does where it
// opens a pop-up, and an answer is GIS calling the callback it was initialized with.
const initialize = jest.fn();
const gisRenderButton = jest.fn((parent: HTMLElement) => {
    const drawn = document.createElement(`div`);
    drawn.setAttribute(`role`, `button`);
    parent.append(drawn);
});
const answer = (given: string): void => {
    const config = initialize.mock.calls.at(-1)?.[0] as { callback: (response: { credential: string }) => void };
    config.callback({ credential: given });
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(Login) });
    app.component(`Icon`, IconStub);
    app.mount(el);
    await flush();
    await nextTick();
    return el;
};

beforeEach(() => {
    localStorage.clear();
    initialize.mockReset();
    gisRenderButton.mockClear();
    push.mockReset();
    signInWithGoogle.mockClear();
    signInWithGoogleCredential.mockClear();
    track.mockReset();
    // A first-time visitor: the silent attempt never answers, so the button is the only road.
    window.google = {
        accounts: { id: { initialize, renderButton: gisRenderButton, prompt: jest.fn(), cancel: jest.fn(), disableAutoSelect: jest.fn() } },
    };
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    // The module is one per window: the credential a test minted would sign the next one in before it began.
    useGoogleIdentity().clearCredential();
    delete window.google;
    document.body.innerHTML = ``;
    jest.restoreAllMocks();
    jest.useRealTimers();
});

it(`signs in with the next answer after one it refused, and says why the first did not`, async () => {
    const el = await mount();

    answer(STALE);
    await flush();
    await nextTick();

    expect(signInWithGoogleCredential).not.toHaveBeenCalled();
    expect(el.textContent).toContain(`its clock may be wrong`);

    answer(GOOD);
    await flush();

    expect(signInWithGoogleCredential).toHaveBeenCalledWith(GOOD);
    expect(push).toHaveBeenCalledWith(`/`);
});

it(`tells the reader a press came back with nothing, and offers Google's own page`, async () => {
    const el = await mount();
    jest.useFakeTimers();
    let focused = true;
    jest.spyOn(document, `hasFocus`).mockImplementation(() => focused);

    el.querySelector(`.entry-socket-slot [role="button"]`)!.dispatchEvent(new Event(`pointerdown`, { bubbles: true }));
    focused = false;
    await advanceTimersByTimeAsync(2_000);
    focused = true;
    await advanceTimersByTimeAsync(3_500);
    await nextTick();

    expect(el.textContent).toContain(`Google's sign-in didn't finish in its window`);
    const googlesPage = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Continue on Google's page`));
    googlesPage?.click();
    expect(signInWithGoogle).toHaveBeenCalledWith(`/`);
    // Google's button stays: it is still the one road that signs in to the platform and the sandbox at once.
    expect(el.querySelector(`.entry-socket-slot [role="button"]`)).not.toBeNull();
});
