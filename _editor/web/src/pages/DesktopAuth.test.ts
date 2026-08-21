// @vitest-environment jsdom
//
// HOW LONG THIS PAGE MAKES SOMEONE WAIT, which is the whole subject: the screen is one person watching a
// spinner, and everything on it is either the wait or a way to end it. The page used to hide Google's button
// behind a five-second timer that only ran out AFTER the silent attempt failed to say anything: the ordinary
// case in a browser that suppresses the prompt, so the first frame offered nothing and the fifth second
// offered a button. These mount the real page and read the FIRST frame: the button is there, and the mint it
// races was asked for without the shared overlay that timer existed to raise.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// The import-time globals a mounted view needs (see Setup.test.ts): ui reads matchMedia at module scope, and
// environment.ts reads window.env and throws without it.

// The link the app opened, carrying the two values the handoff is tied to.
const query = ref<Record<string, string>>({ state: `nonce-1`, challenge: `chal-1` });
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () =>
        ({
            get query() {
                return query.value;
            },
            get fullPath() {
                return `/desktop-auth?${new URLSearchParams(query.value).toString()}`;
            },
        }) as never,
}));

// A mint that never settles: the silent attempt going quiet is exactly the case these tests are about, and it
// is what leaves the first frame standing still to be read.
const getIdToken = vi.fn<(options?: { gate?: boolean; usableFor?: number }) => Promise<string | undefined>>(() => new Promise<never>(() => {}));
// True: an ordinary browser, where Google's button renders. The refusal case (the desktop webview) and what
// every surface owes the reader there is signInSurfaces.test.ts's whole subject.
const renderButton = vi.fn<(parent: HTMLElement, dark: boolean) => Promise<boolean>>().mockResolvedValue(true);
const adoptIdToken = vi.fn<(credential: string) => boolean>().mockReturnValue(true);
vi.mock(`../composables/useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ getIdToken, renderButton, adoptIdToken }) }));
const signInWithGoogle = vi.fn<(callbackPath?: string) => Promise<void>>().mockResolvedValue(undefined);
vi.mock(`../composables/useAuth`, () => ({ useAuth: () => ({ user: ref({ email: `owner@example.com` }), signInWithGoogle }) }));
const handoff = vi.fn();
// The credential the platform already holds. Undefined answer = it holds nothing usable, which is the case
// the Google button below exists for.
const googleIdToken = vi.fn<() => Promise<{ idToken?: string }>>().mockResolvedValue({});
vi.mock(`../composables/useApi`, () => ({ apiClient: { desktop: { handoff, googleIdToken } } }));

// A Google credential shaped the way idTokenClaims (not mocked here) actually reads one, so the page's own
// freshness check runs for real rather than against a stub that always says yes.
const credential = (livesForMs: number): string => {
    const payload = { email: `owner@example.com`, exp: Math.floor((Date.now() + livesForMs) / 1000) };
    const body = btoa(JSON.stringify(payload)).replace(/\+/g, `-`).replace(/\//g, `_`).replace(/=+$/, ``);
    return `header.${body}.signature`;
};

const { default: DesktopAuth } = await import("./DesktopAuth.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(DesktopAuth) });
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
    await nextTick();
    await nextTick();
    return el;
};

beforeEach(() => {
    query.value = { state: `nonce-1`, challenge: `chal-1` };
    getIdToken.mockClear();
    renderButton.mockClear();
    adoptIdToken.mockClear();
    signInWithGoogle.mockClear();
    handoff.mockReset();
    googleIdToken.mockReset().mockResolvedValue({});
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`puts Google's button up the moment the platform says it holds nothing, with no timer between`, async () => {
    await mount();

    // No fake clock is advanced anywhere in this test. The button waits on one answer: does the platform
    // already hold this credential, and on nothing else; the five-second guard it used to sit behind ran
    // AFTER a silent Google attempt that says nothing in most browsers, so the wait was never informative.
    expect(renderButton).toHaveBeenCalledTimes(1);
    expect(renderButton.mock.calls[0]?.[0]).toBeInstanceOf(HTMLElement);
});

it(`asks for the token without the shared sign-in overlay, and only one with real life left`, async () => {
    await mount();

    // `gate: false` is what removes the five-second guard: the overlay it would raise is a second Google
    // button on a page whose own button is already up.
    //
    // `usableFor` is the other half, and it is about what happens AFTER this page. The credential leaves for
    // another process that cannot spend it until it has a daemon to spend it on: a whole setup away after a
    // fresh install. A cached token a minute from death satisfies this page and strands the app.
    expect(getIdToken).toHaveBeenCalledWith({ gate: false, usableFor: expect.any(Number) });
    expect(getIdToken.mock.calls[0]?.[0]?.usableFor).toBeGreaterThanOrEqual(10 * 60 * 1000);
});

it(`says what the button is for while the sign-in is outstanding`, async () => {
    const el = await mount();

    expect(el.textContent).toContain(`Continue with Google`);
    // The handoff line belongs to the LATER wait: showing it now described a step that has not started.
    expect(el.textContent).not.toContain(`Handing your sign-in`);
});

/* THE SECOND ASK, GONE. Someone here pressed sign in inside the app and is already signed in in this browser.
 * A Google button on top of that is a third act of consent for something twice agreed to, and it is the step
 * people were stalling on, so the credential is asked of the platform, and Google is never shown. */
it(`finishes with no Google surface at all when the platform already holds the credential`, async () => {
    googleIdToken.mockResolvedValue({ idToken: credential(60 * 60 * 1000) });
    handoff.mockResolvedValue({ handoff: `row-1` });

    const el = await mount();
    await nextTick();

    expect(handoff).toHaveBeenCalledWith({ idToken: expect.any(String), challenge: `chal-1` });
    expect(renderButton).not.toHaveBeenCalled();
    expect(getIdToken).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain(`Continue with Google`);
});

// The same credential this browser's own sandbox gate wants, so one fetch settles both rather than leaving a
// second Google prompt waiting inside the workspace.
it(`keeps the platform's credential for this browser too`, async () => {
    const held = credential(60 * 60 * 1000);
    googleIdToken.mockResolvedValue({ idToken: held });
    handoff.mockResolvedValue({ handoff: `row-1` });

    await mount();
    await nextTick();

    expect(adoptIdToken).toHaveBeenCalledWith(held);
});

/* This token LEAVES for a process that may not spend it for a whole setup, so one the daemon would reject on
 * arrival is worth no more than none at all: take Google's button instead, where a fresh one can be had. */
it(`treats a nearly-dead held credential as nothing held`, async () => {
    googleIdToken.mockResolvedValue({ idToken: credential(60 * 1000) });

    const el = await mount();
    await nextTick();

    expect(handoff).not.toHaveBeenCalled();
    expect(renderButton).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain(`Continue with Google`);
});

// A platform that does not answer this at all (an older build, a self-hosted one) is not an error state.
// It holds nothing, which is precisely the case the button already covered.
it(`falls back to Google's button when the platform cannot answer`, async () => {
    googleIdToken.mockRejectedValue(new Error(`no such route`));

    const el = await mount();
    await nextTick();

    expect(renderButton).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain(`Continue with Google`);
    expect(el.textContent).not.toContain(`Couldn't finish signing in`);
});

/* The failure nothing on this page can see: Google's button renders, takes the click, and does nothing:
 * a blocked frame, an extension, an origin Google has stopped accepting. Without a way out that needs none of
 * that machinery, the screen is indistinguishable from one that is simply broken. */
it(`always offers Google's own page while the embedded button is up`, async () => {
    const el = await mount();
    await nextTick();

    const escape = [...el.querySelectorAll(`button`)].find((node) => node.textContent?.includes(`Google's own page`));
    expect(escape).toBeDefined();

    escape?.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
    await nextTick();

    // Back to THIS link, state and challenge intact, so the hand-off resumes by itself on return.
    expect(signInWithGoogle).toHaveBeenCalledWith(expect.stringContaining(`state=nonce-1`));
    expect(signInWithGoogle.mock.calls[0]?.[0]).toContain(`challenge=chal-1`);
});

it(`asks Google for nothing when the link is missing its handoff values`, async () => {
    query.value = {};

    const el = await mount();

    expect(getIdToken).not.toHaveBeenCalled();
    expect(renderButton).not.toHaveBeenCalled();
    expect(el.textContent).toContain(`missing the value that ties it to your app`);
});
