// @vitest-environment jsdom
// The desktop app's embedded webview can't complete Google sign-in (no FedCM support), so it hands off to the real
// browser instead of rendering Google's own button; an ordinary browser keeps that button.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Needs jsdom: ui reads matchMedia at module scope, and environment.ts reads window.env and throws without it.

vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) as never,
}));

// The gate is open for every test here: that is the state it exists in.
const needsSignIn = ref(true);
const renderButton = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
const cancelSignIn = vi.fn();
vi.mock(`../../auth/useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ needsSignIn, renderButton, cancelSignIn }) }));
vi.mock(`../../auth/useAuth`, () => ({ useAuth: () => ({ user: ref({ email: `owner@example.com` }) }) }));
vi.mock(`../client/useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId: ref(undefined) }) }));

const signInThroughBrowser = vi.fn();
const desktopVersion = vi.fn<() => string | undefined>();
vi.mock(`../../../app/environments/desktop`, () => ({
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
    app.component(`Icon`, IconStub);
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

    expect(signInThroughBrowser).toHaveBeenCalledTimes(1);
});

it(`never renders Google's own button inside the desktop app`, async () => {
    desktopVersion.mockReturnValue(`1.2.3`);

    await mount();

    expect(renderButton).not.toHaveBeenCalled();
});

it(`keeps Google's own button in an ordinary browser`, async () => {
    await mount();

    expect(renderButton).toHaveBeenCalledTimes(1);
    expect(buttonSaying(`Continue with Google in your browser`)).toBeUndefined();
});
