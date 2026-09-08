// @vitest-environment jsdom
// The page mints one Google credential and spends it twice: once on the platform, once (from the same cache) on
// the sandbox, replacing two separate Google prompts. These tests check that the token handed to the platform is
// the one the browser itself minted, and that every failure path falls back to the redirect rather than a dead page.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Mounting reads matchMedia (ui) and window.env (environment.ts) at module scope; see Setup.test.ts.

const push = vi.fn();
// Where the guard that turned somebody away wrote the page they were headed to (router/signIn.ts).
const query = ref<Record<string, string>>({});
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRouter: () => ({ push, replace: vi.fn() }) as never,
    useRoute: () =>
        ({
            get query() {
                return query.value;
            },
        }) as never,
}));

const signInWithGoogle = vi.fn().mockResolvedValue(undefined);
const signInWithGoogleCredential = vi.fn().mockResolvedValue(undefined);
vi.mock(`./useAuth`, () => ({
    useAuth: () => ({ user: ref(null), signInWithGoogle, signInWithGoogleCredential }),
}));

const getIdToken = vi.fn<(options?: { gate?: boolean }) => Promise<string | undefined>>();
const renderButton = vi.fn<() => Promise<boolean>>();
vi.mock(`./useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ getIdToken, renderButton }) }));
// Available desktop build for this visitor; undefined is the default, overridden only where a test needs one.
const desktopInstaller = vi.fn<() => { platform: string; label: string; href: string } | undefined>(() => undefined);
vi.mock(`../../app/environments/desktop`, () => ({
    DESKTOP_SIGN_IN_LINK: ``,
    desktopVersion: () => undefined,
    desktopInstaller: () => desktopInstaller(),
    openDesktopLink: vi.fn(),
}));

const { default: Login } = await import("./Login.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(Login) });
    app.component(`Icon`, IconStub);
    app.mount(el);
    // The sign-in chain is several awaits deep; a macrotask flush avoids a fixed, fragile tick count.
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    await nextTick();
    return el;
};

// The old redirect control, found by its label; its presence is the fallback being offered.
const redirectButton = (): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Continue with Google`));

beforeEach(() => {
    query.value = {};
    push.mockReset();
    signInWithGoogle.mockReset().mockResolvedValue(undefined);
    signInWithGoogleCredential.mockReset().mockResolvedValue(undefined);
    // Steady state: Google's button renders and yields a credential.
    renderButton.mockReset().mockResolvedValue(true);
    getIdToken.mockReset().mockResolvedValue(`google-id-token`);
    desktopInstaller.mockReset().mockReturnValue(undefined);
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`signs in to the platform with the token the browser minted`, async () => {
    await mount();

    // Direction is the security property: a credential this window holds goes into the platform, nothing comes back,
    // so sandbox trust never depends on the platform's honesty.
    expect(signInWithGoogleCredential).toHaveBeenCalledWith(`google-id-token`);
    expect(push).toHaveBeenCalledWith(`/`);
});

// Both exits from this page must return to where the guard sent the visitor, not hardcode `/`, or a deep link is
// lost the moment sign-in redirects home. Asserted on both paths since one pushes and the other hands it to Better
// Auth as an OAuth callback.
it(`lands on the page that asked for the sign-in`, async () => {
    query.value = { returnTo: `/sandbox/usage` };

    await mount();

    expect(push).toHaveBeenCalledWith(`/sandbox/usage`);
});

it(`brings Google's redirect back to that same page`, async () => {
    query.value = { returnTo: `/sandbox/usage` };
    renderButton.mockResolvedValue(false);
    getIdToken.mockResolvedValue(undefined);

    await mount();
    redirectButton()?.click();
    await nextTick();

    expect(signInWithGoogle).toHaveBeenCalledWith(`/sandbox/usage`);
});

// An unchecked returnTo makes this the one page users expect Google on into an open redirect; `//host` is
// protocol-relative to every URL parser.
it(`refuses a destination that leaves this origin`, async () => {
    query.value = { returnTo: `//evil.example` };

    await mount();

    expect(push).toHaveBeenCalledWith(`/`);
});

it(`asks Google without raising the shared overlay, since its own button is the gate`, async () => {
    await mount();

    expect(getIdToken).toHaveBeenCalledWith({ gate: false });
});

it(`renders Google's own button rather than the redirect`, async () => {
    getIdToken.mockReturnValue(new Promise<never>(() => {}));

    await mount();

    expect(renderButton).toHaveBeenCalledTimes(1);
    expect(redirectButton()).toBeUndefined();
});

it(`falls back to the redirect when Google's script never arrives`, async () => {
    renderButton.mockResolvedValue(false);
    getIdToken.mockResolvedValue(undefined);

    await mount();

    expect(redirectButton()).toEqual(expect.any(Object));
    expect(signInWithGoogleCredential).not.toHaveBeenCalled();
});

it(`falls back to the redirect when the platform refuses a token Google signed`, async () => {
    signInWithGoogleCredential.mockRejectedValue(new Error(`no such endpoint`));

    const el = await mount();

    // A platform refusal (older build, client-id mismatch) says nothing about whether the sandbox will refuse too, so
    // the user gets another way in instead of a dead page.
    expect(redirectButton()).toEqual(expect.any(Object));
    expect(el.textContent).toContain(`Continue with Google below instead`);
    expect(push).not.toHaveBeenCalled();
});

it(`always offers a way in that does not depend on Google's embedded button`, async () => {
    getIdToken.mockReturnValue(new Promise<never>(() => {}));

    const el = await mount();
    const escape = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Trouble signing in`));
    escape?.click();
    await nextTick();

    // The button can fail silently (blocked frame, popup policy), indistinguishable from a page doing nothing.
    expect(escape).toEqual(expect.any(Object));
    expect(signInWithGoogle).toHaveBeenCalledTimes(1);
});

// The copy must track `desktopInstaller`: promising a pasted command to a visitor who's actually given a Download
// button (or vice versa) is checked both ways, since either case alone would pass with the value hardcoded.
it(`promises the pasted command only where there is no build to install`, async () => {
    const el = await mount();

    expect(el.textContent).toContain(`Paste one command`);
    expect(el.textContent).not.toContain(`Install the app`);
});

it(`promises the installer on a machine we ship a build for`, async () => {
    desktopInstaller.mockReturnValue({ platform: `windows`, label: `Windows`, href: `https://intentic.dev/desktop/windows` });

    const el = await mount();

    expect(el.textContent).toContain(`Install the app`);
    expect(el.textContent).not.toContain(`Paste one command`);
});

it(`leaves the page usable when the user dismisses Google`, async () => {
    getIdToken.mockResolvedValue(undefined);

    const el = await mount();

    expect(signInWithGoogleCredential).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    // A dismissal says nothing; the button the user turned away from is still there.
    expect(el.textContent).not.toContain(`Continue with Google below instead`);
});
