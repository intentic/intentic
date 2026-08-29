// @vitest-environment jsdom
//
// ONE GOOGLE SIGN-IN INSTEAD OF TWO, which is the whole subject of this page now. Signing in used to bounce
// off to Google and back, which proves the user to the platform and leaves the browser holding NOTHING, so
// the sandbox, which authenticates people against Google itself and does not trust the platform, had to ask
// for Google a second time. People read that second ask as a bug and some left at it.
//
// The page now mints the Google credential HERE and spends it twice: once on the platform, once (from the
// cache it already lives in) on the sandbox. These tests hold the two things that must stay true: that the
// token handed to the platform is the one the BROWSER minted, never the other way round, and that all three
// ways this can fail land on the old redirect rather than on a dead page.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// The import-time globals a mounted view needs (see Setup.test.ts): ui reads matchMedia at module scope, and
// environment.ts reads window.env and throws without it.

const push = vi.fn();
// Where the guard that turned somebody away wrote the page they were going to (router/signIn.ts).
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
vi.mock(`../composables/useAuth`, () => ({
    useAuth: () => ({ user: ref(null), signInWithGoogle, signInWithGoogleCredential }),
}));

const getIdToken = vi.fn<(options?: { gate?: boolean }) => Promise<string | undefined>>();
const renderButton = vi.fn<() => Promise<boolean>>();
vi.mock(`../composables/useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ getIdToken, renderButton }) }));
// Which build, if any, this visitor's machine can run. `undefined` is "none" (macOS today), which is the
// steady state for every test below except the pair that assert the third step follows it.
const desktopInstaller = vi.fn<() => { platform: string; label: string; href: string } | undefined>(() => undefined);
vi.mock(`../environments/desktop`, () => ({
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
    // The sign-in chain is several awaits deep: a macrotask flushes it where a fixed count of ticks goes stale.
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    await nextTick();
    return el;
};

// The old redirect control, found by its label: its presence IS the fallback being offered.
const redirectButton = (): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Continue with Google`));

beforeEach(() => {
    query.value = {};
    push.mockReset();
    signInWithGoogle.mockReset().mockResolvedValue(undefined);
    signInWithGoogleCredential.mockReset().mockResolvedValue(undefined);
    // The steady state: Google's button renders, and a credential arrives from it.
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

    // The DIRECTION is the security property: a Google credential this window already holds goes INTO the
    // platform. Nothing comes back out, so what the sandbox trusts never depends on the platform being honest.
    expect(signInWithGoogleCredential).toHaveBeenCalledWith(`google-id-token`);
    expect(push).toHaveBeenCalledWith(`/`);
});

/* THE PAGE THAT SENT THEM HERE, which both ways out of this screen used to forget: each hardcoded `/`, so a
 * guard that turned somebody away from a deep link signed them in and then dropped them in the workspace with
 * the address they asked for gone. Both paths are asserted because they fail independently — one pushes, the
 * other hands the path to Better Auth as an OAuth callback. */
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

/* An unchecked destination on THIS screen is an open redirect wearing the one page a user has been taught to
 * expect Google on: `//host` is protocol-relative to every URL parser there is. */
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

    expect(renderButton).toHaveBeenCalled();
    expect(redirectButton()).toBeUndefined();
});

it(`falls back to the redirect when Google's script never arrives`, async () => {
    renderButton.mockResolvedValue(false);
    getIdToken.mockResolvedValue(undefined);

    await mount();

    expect(redirectButton()).toBeDefined();
    expect(signInWithGoogleCredential).not.toHaveBeenCalled();
});

it(`falls back to the redirect when the platform refuses a token Google signed`, async () => {
    signInWithGoogleCredential.mockRejectedValue(new Error(`no such endpoint`));

    const el = await mount();

    // A platform that will not take it (an older self-hosted build, a client-id mismatch) says NOTHING about
    // whether the sandbox will, so the user gets the other way in rather than a dead page.
    expect(redirectButton()).toBeDefined();
    expect(el.textContent).toContain(`Continue with Google below instead`);
    expect(push).not.toHaveBeenCalled();
});

it(`always offers a way in that does not depend on Google's embedded button`, async () => {
    getIdToken.mockReturnValue(new Promise<never>(() => {}));

    const el = await mount();
    const escape = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Trouble signing in`));
    escape?.click();
    await nextTick();

    // The ways that button can fail silently (a blocked frame, a popup policy) are invisible from this page,
    // and each of them looks like a sign-in page that simply does nothing.
    expect(escape).toBeDefined();
    expect(signInWithGoogle).toHaveBeenCalled();
});

/* THE THIRD STEP HAS TO DESCRIBE THE FLOW THIS VISITOR WILL ACTUALLY BE GIVEN.
 *
 * This band is the product's first description of itself, and it promised "Paste one command / One line starts
 * it on your own machine" to everybody — including Windows and Linux, where the setup page then hands over a
 * Download button and no command is ever shown. The reader most likely to be put off by a terminal was told,
 * on the way in, that there would be one. Both directions are asserted because the copy is only right when it
 * tracks `desktopInstaller`, and a single case would pass with the value hardcoded either way. */
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
    // Nothing is said about a dismissal: the button the user turned away from is still standing there.
    expect(el.textContent).not.toContain(`Continue with Google below instead`);
});
