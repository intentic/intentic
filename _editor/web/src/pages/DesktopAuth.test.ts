// @vitest-environment jsdom
//
// HOW LONG THIS PAGE MAKES SOMEONE WAIT, which is the whole subject: the screen is one person watching a
// spinner, and everything on it is either the wait or a way to end it. The page used to hide Google's button
// behind a five-second timer that only ran out AFTER the silent attempt failed to say anything — the ordinary
// case in a browser that suppresses the prompt — so the first frame offered nothing and the fifth second
// offered a button. These mount the real page and read the FIRST frame: the button is there, and the mint it
// races was asked for without the shared overlay that timer existed to raise.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

// The link the app opened, carrying the two values the handoff is tied to.
const query = ref<Record<string, string>>({ state: `nonce-1`, challenge: `chal-1` });
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () =>
        ({
            get query() {
                return query.value;
            },
        }) as never,
}));

// A mint that never settles: the silent attempt going quiet is exactly the case these tests are about, and it
// is what leaves the first frame standing still to be read.
const getIdToken = vi.fn(() => new Promise<never>(() => {}));
const renderButton = vi.fn().mockResolvedValue(undefined);
vi.mock(`../composables/useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ getIdToken, renderButton }) }));
vi.mock(`../composables/useAuth`, () => ({ useAuth: () => ({ user: ref({ email: `owner@example.com` }) }) }));
const handoff = vi.fn();
vi.mock(`../composables/useApi`, () => ({ apiClient: { desktop: { handoff } } }));

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
    handoff.mockReset();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`puts Google's button on the first frame, with no timer between`, async () => {
    await mount();

    // No fake clock is advanced anywhere in this test — the button is asked for on mount or not at all.
    expect(renderButton).toHaveBeenCalledTimes(1);
    expect(renderButton.mock.calls[0]?.[0]).toBeInstanceOf(HTMLElement);
});

it(`asks for the token without the shared sign-in overlay`, async () => {
    await mount();

    // `gate: false` is what removes the five-second guard: the overlay it would raise is a second Google
    // button on a page whose own button is already up.
    expect(getIdToken).toHaveBeenCalledWith({ gate: false });
});

it(`says what the button is for while the sign-in is outstanding`, async () => {
    const el = await mount();

    expect(el.textContent).toContain(`Continue with Google`);
    // The handoff line belongs to the LATER wait — showing it now described a step that has not started.
    expect(el.textContent).not.toContain(`Handing your sign-in`);
});

it(`asks Google for nothing when the link is missing its handoff values`, async () => {
    query.value = {};

    const el = await mount();

    expect(getIdToken).not.toHaveBeenCalled();
    expect(renderButton).not.toHaveBeenCalled();
    expect(el.textContent).toContain(`missing the value that ties it to your app`);
});
