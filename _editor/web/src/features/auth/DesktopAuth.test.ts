// @vitest-environment jsdom
// These tests mount the real page and read the first frame: Google's button must be there immediately, and the
// credential mint it races runs without the shared sign-in overlay.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Mounting reads matchMedia (ui) and window.env (environment.ts) at module scope; see Setup.test.ts.

// The link's query params carrying the state and challenge the handoff is tied to.
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

// A mint that never settles, since a silent attempt going quiet is what these tests read on the first frame.
const getIdToken = vi.fn<(options?: { gate?: boolean; usableFor?: number }) => Promise<string | undefined>>(() => new Promise<never>(() => {}));
// An ordinary browser, where Google's button renders; the webview refusal case is signInSurfaces.test.ts's case.
const renderButton = vi.fn<(parent: HTMLElement, dark: boolean) => Promise<boolean>>().mockResolvedValue(true);
const adoptIdToken = vi.fn<(credential: string) => boolean>().mockReturnValue(true);
vi.mock(`./useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ getIdToken, renderButton, adoptIdToken }) }));
const signInWithGoogle = vi.fn<(callbackPath?: string) => Promise<void>>().mockResolvedValue(undefined);
// What this window's session resolves to; null means a signed-out browser, covered by the tests below.
const user = ref<{ email: string } | null>({ email: `owner@example.com` });
const refresh = vi.fn<() => Promise<{ email: string } | null>>().mockResolvedValue(null);
const signInWithGoogleCredential = vi.fn<(idToken: string) => Promise<void>>().mockResolvedValue(undefined);
vi.mock(`./useAuth`, () => ({ useAuth: () => ({ user, refresh, signInWithGoogle, signInWithGoogleCredential }) }));
const handoff = vi.fn();
// The credential the platform already holds; undefined means it holds nothing usable.
const googleIdToken = vi.fn<() => Promise<{ idToken?: string }>>().mockResolvedValue({});
vi.mock(`../../lib/useApi`, () => ({ apiClient: { desktop: { handoff, googleIdToken } } }));

// A Google credential shaped like idTokenClaims actually reads one, so the page's freshness check runs for real,
// not against a stub.
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
    app.component(`Icon`, IconStub);
    app.mount(el);
    // Awaits several deep (session, platform, Google); a macrotask flush avoids hardcoding a tick count.
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    await nextTick();
    return el;
};

beforeEach(() => {
    query.value = { state: `nonce-1`, challenge: `chal-1` };
    user.value = { email: `owner@example.com` };
    getIdToken.mockClear();
    renderButton.mockClear();
    adoptIdToken.mockClear();
    signInWithGoogle.mockClear();
    refresh.mockReset().mockResolvedValue(null);
    signInWithGoogleCredential.mockReset().mockResolvedValue(undefined);
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

    // No fake clock; the button only waits on whether the platform already holds the credential.
    expect(renderButton).toHaveBeenCalledTimes(1);
    expect(renderButton.mock.calls[0]?.[0]).toBeInstanceOf(HTMLElement);
});

it(`asks for the token without the shared sign-in overlay, and only one with real life left`, async () => {
    await mount();

    // `gate: false` skips the redundant overlay button. `usableFor` requires enough life to survive setup after a
    // fresh install, not just this page.
    expect(getIdToken).toHaveBeenCalledWith({ gate: false, usableFor: expect.any(Number) });
    expect(getIdToken.mock.calls[0]?.[0]?.usableFor).toBeGreaterThanOrEqual(10 * 60 * 1000);
});

it(`says what the button is for while the sign-in is outstanding`, async () => {
    const el = await mount();

    expect(el.textContent).toContain(`Continue with Google`);
    // Belongs to a later wait; showing it now would describe a step that hasn't started.
    expect(el.textContent).not.toContain(`Handing your sign-in`);
});

// Signed in already in-app and in-browser; a Google button here would be a redundant third consent, so the
// platform's own credential is used and Google is never shown.
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

// Same credential this browser's own sandbox gate wants, so one fetch settles both instead of a second Google
// prompt.
it(`keeps the platform's credential for this browser too`, async () => {
    const held = credential(60 * 60 * 1000);
    googleIdToken.mockResolvedValue({ idToken: held });
    handoff.mockResolvedValue({ handoff: `row-1` });

    await mount();
    await nextTick();

    expect(adoptIdToken).toHaveBeenCalledWith(held);
});

// This token leaves for a process that may not spend it for a while; one the daemon would reject on arrival is
// worth nothing, so fall back to Google's button.
it(`treats a nearly-dead held credential as nothing held`, async () => {
    googleIdToken.mockResolvedValue({ idToken: credential(60 * 1000) });

    const el = await mount();
    await nextTick();

    expect(handoff).not.toHaveBeenCalled();
    expect(renderButton).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain(`Continue with Google`);
});

// A platform that can't answer this at all (older or self-hosted build) isn't an error; it's the same as holding
// nothing.
it(`falls back to Google's button when the platform cannot answer`, async () => {
    googleIdToken.mockRejectedValue(new Error(`no such route`));

    const el = await mount();
    await nextTick();

    expect(renderButton).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain(`Continue with Google`);
    expect(el.textContent).not.toContain(`Couldn't finish signing in`);
});

// Covers a Google button that renders but silently does nothing (blocked frame, extension, rejected origin); the
// escape hatch needs none of that machinery to work.
it(`always offers Google's own page while the embedded button is up`, async () => {
    const el = await mount();
    await nextTick();

    const escape = [...el.querySelectorAll(`button`)].find((node) => node.textContent?.includes(`Google's own page`));

    escape?.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
    await nextTick();

    // Same link: state and challenge intact, so the handoff resumes on return.
    expect(signInWithGoogle).toHaveBeenCalledWith(expect.stringContaining(`state=nonce-1`));
    expect(signInWithGoogle.mock.calls[0]?.[0]).toContain(`challenge=chal-1`);
});

// The default OS browser the app opens is often signed out or on another account; this is the ordinary case, not
// an edge one.
it(`signs an unsigned browser in with the credential it minted, and hands the same one over`, async () => {
    user.value = null;
    const minted = credential(60 * 60 * 1000);
    getIdToken.mockResolvedValueOnce(minted);
    handoff.mockResolvedValue({ handoff: `row-1` });

    await mount();

    // One Google interaction serves twice: it signs the user in and is the credential the daemon verifies.
    expect(signInWithGoogleCredential).toHaveBeenCalledWith(minted);
    expect(handoff).toHaveBeenCalledWith({ idToken: minted, challenge: `chal-1` });
});

// A sessionless call gets a 401, which tears down the signed-in runtime, including any Google mint in flight.
// Asking at all is the bug.
it(`asks the platform for a credential it cannot be holding`, async () => {
    user.value = null;

    await mount();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(googleIdToken).not.toHaveBeenCalled();
});

// A signed-in browser keeps its account; re-spending the token would silently switch it to whichever account
// Google answers with.
it(`leaves a signed-in browser on the account it is already using`, async () => {
    googleIdToken.mockResolvedValue({});
    getIdToken.mockResolvedValueOnce(credential(60 * 60 * 1000));
    handoff.mockResolvedValue({ handoff: `row-1` });

    await mount();

    expect(signInWithGoogleCredential).not.toHaveBeenCalled();
    expect(handoff).toHaveBeenCalledTimes(1);
});

it(`asks Google for nothing when the link is missing its handoff values`, async () => {
    query.value = {};

    const el = await mount();

    expect(getIdToken).not.toHaveBeenCalled();
    expect(renderButton).not.toHaveBeenCalled();
    expect(el.textContent).toContain(`missing the value that ties it to your app`);
});
