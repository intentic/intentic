// @vitest-environment jsdom
//
// THE ONE SCREEN THAT MUST NEVER BE A DEAD END. This gate opens whenever the sandbox needs a Google
// credential, and inside the desktop app it used to render Google's own button, which appears, is clickable,
// and does nothing at all: Google refuses OAuth from an embedded webview and Identity Services is FedCM-based,
// which that webview does not implement. A person who had just installed the app sat on this card clicking a
// button that could never work, with only "Back to setup" as a way out.
//
// The login screen has always answered this by handing sign-in to the real browser; this gate had not. These
// hold both halves: the app window gets the hand-off, an ordinary browser keeps Google's own button, and
// neither one is ever offered the other's.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// The import-time globals a mounted view needs (see Setup.test.ts): ui reads matchMedia at module scope, and
// environment.ts reads window.env and throws without it.

vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) as never,
}));

// The gate is open for every test here: that is the state it exists in.
const needsSignIn = ref(true);
const renderButton = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
const cancelSignIn = vi.fn();
vi.mock(`../composables/useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ needsSignIn, renderButton, cancelSignIn }) }));
vi.mock(`../composables/useAuth`, () => ({ useAuth: () => ({ user: ref({ email: `owner@example.com` }) }) }));
vi.mock(`../composables/sandbox/useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId: ref(undefined) }) }));

const signInThroughBrowser = vi.fn();
const desktopVersion = vi.fn<() => string | undefined>();
vi.mock(`../environments/desktop`, () => ({
    DESKTOP_SIGN_IN_LINK: `intentic://signin`,
    desktopVersion: () => desktopVersion(),
    openDesktopLink: vi.fn(),
    signInThroughBrowser: () => signInThroughBrowser(),
}));

const { default: GoogleSigninGate } = await import("./GoogleSigninGate.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(GoogleSigninGate) });
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

const buttonSaying = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((button) => button.textContent?.includes(text));

beforeEach(() => {
    needsSignIn.value = true;
    renderButton.mockClear().mockResolvedValue(true);
    signInThroughBrowser.mockReset();
    desktopVersion.mockReset().mockReturnValue(undefined);
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`hands sign-in to the real browser inside the desktop app`, async () => {
    desktopVersion.mockReturnValue(`1.2.3`);

    await mount();
    buttonSaying(`Continue with Google in your browser`)?.click();

    expect(signInThroughBrowser).toHaveBeenCalled();
});

it(`never renders Google's own button inside the desktop app`, async () => {
    desktopVersion.mockReturnValue(`1.2.3`);

    await mount();

    // It renders there and does nothing when clicked, which is indistinguishable from a broken app.
    expect(renderButton).not.toHaveBeenCalled();
});

it(`keeps Google's own button in an ordinary browser`, async () => {
    await mount();

    expect(renderButton).toHaveBeenCalled();
    expect(buttonSaying(`Continue with Google in your browser`)).toBeUndefined();
});
