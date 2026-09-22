// The sign-in gate's three states. Choose: Google's button in an ordinary browser, the hand-off to the real browser
// inside the desktop app (no FedCM there), and a passkey beside either once the daemon says one is registered here.
// Step-up: the passkey the sandbox requires, or the walk through adding a first one, with the owner's recovery code.
import "@intentic/testing/dom";
import type { DaemonSession } from "@intentic/sandbox-contract";
import { it, expect, beforeEach, afterEach, mock } from "bun:test";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as vueRouterOriginal from "vue-router";

// Needs jsdom: ui reads matchMedia at module scope, and environment.ts reads window.env and throws without it.

mock.module(`vue-router`, () => ({
    ...vueRouterOriginal,
    useRouter: () => ({ push: mock(), replace: mock() }) as never,
}));

// Google's gate is open unless a test closes it: that is the state the overlay exists in.
const needsSignIn = ref(true);
const renderButton = mock<() => Promise<boolean>>().mockResolvedValue(true);
const cancelSignIn = mock();
mock.module(`../../auth/useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ needsSignIn, renderButton, cancelSignIn }) }));
mock.module(`../../auth/useAuth`, () => ({ useAuth: () => ({ user: ref({ email: `owner@example.com` }) }) }));
const activeSandbox = ref<{ role: string } | undefined>({ role: `owner` });
mock.module(`../client/useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId: ref(undefined), active: activeSandbox }) }));

const signInThroughBrowser = mock();
const desktopVersion = mock<() => string | undefined>();
mock.module(`../../../app/environments/desktop`, () => ({
    DESKTOP_SIGN_IN_LINK: `intentic://signin`,
    desktopVersion: () => desktopVersion(),
    openDesktopLink: mock(),
    signInThroughBrowser: () => signInThroughBrowser(),
}));

// The ceremonies are the browser's WebAuthn calls plus the daemon; here they answer whatever the test says.
const SESSION: DaemonSession = { token: `sess-passkey`, expiresAt: 4_102_444_800_000, email: `owner@example.com` };
const supportsPasskeys = mock(() => true);
const signInWithPasskey = mock<() => Promise<DaemonSession>>();
const registerPasskey = mock<() => Promise<{ passkey: unknown; session?: DaemonSession }>>();
const recoverWithCode = mock<() => Promise<DaemonSession & { remaining: number }>>();
mock.module(`../session/passkeySignIn`, () => ({
    browserSupportsPasskeys: () => supportsPasskeys(),
    signInWithPasskey: (...args: unknown[]) => signInWithPasskey(...(args as [])),
    registerPasskey: (...args: unknown[]) => registerPasskey(...(args as [])),
    recoverWithCode: (...args: unknown[]) => recoverWithCode(...(args as [])),
}));

const { default: SignInWall } = await import("./SignInWall.vue");
const { dismissSignIn, offerPasskey, raiseSignIn } = await import("../session/signInPrompt");

const TARGET = { sandboxId: `sb-1`, base: `https://daemon.test`, connectToken: `connect` };

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SignInWall) });
    app.component(`Icon`, IconStub);
    app.mount(el);
    await nextTick();
    await nextTick();
    return el;
};

const buttonSaying = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((button) => button.textContent?.includes(text));

const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
};

beforeEach(() => {
    needsSignIn.value = true;
    activeSandbox.value = { role: `owner` };
    renderButton.mockClear().mockResolvedValue(true);
    signInThroughBrowser.mockReset();
    desktopVersion.mockReset().mockReturnValue(undefined);
    supportsPasskeys.mockReset().mockReturnValue(true);
    signInWithPasskey.mockReset();
    registerPasskey.mockReset();
    recoverWithCode.mockReset();
});

afterEach(() => {
    dismissSignIn();
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

it(`offers a passkey beside Google's button only once the daemon says one is registered here, and its session settles the prompt`, async () => {
    const outcome = raiseSignIn({ kind: `choose`, target: TARGET, passkey: false });
    await mount();
    expect(buttonSaying(`Use a passkey`)).toBeUndefined();

    offerPasskey(TARGET, true);
    await nextTick();
    signInWithPasskey.mockResolvedValue(SESSION);
    buttonSaying(`Use a passkey`)?.click();
    await settle();

    expect(signInWithPasskey).toHaveBeenCalledWith(TARGET);
    await expect(outcome).resolves.toEqual(SESSION);
});

it(`never offers a passkey in a window without WebAuthn, whatever the daemon holds`, async () => {
    supportsPasskeys.mockReturnValue(false);
    void raiseSignIn({ kind: `choose`, target: TARGET, passkey: true });
    await mount();

    expect(buttonSaying(`Use a passkey`)).toBeUndefined();
});

it(`the step-up asks for the passkey held, with no Google button in sight`, async () => {
    needsSignIn.value = false;
    const outcome = raiseSignIn({ kind: `step-up`, target: TARGET, enrolled: true, bearer: `google-proof` });
    const el = await mount();

    expect(el.textContent).toContain(`Confirm it's you`);
    expect(renderButton).not.toHaveBeenCalled();
    signInWithPasskey.mockResolvedValue(SESSION);
    buttonSaying(`Use your passkey`)?.click();
    await settle();

    await expect(outcome).resolves.toEqual(SESSION);
});

it(`the step-up for someone with no passkey yet walks through adding the first, under the proof that was taken`, async () => {
    needsSignIn.value = false;
    const outcome = raiseSignIn({ kind: `step-up`, target: TARGET, enrolled: false, bearer: `google-proof` });
    const el = await mount();
    expect(el.textContent).toContain(`Add a passkey to continue`);

    const field = el.querySelector(`input[placeholder^="Name it"]`) as HTMLInputElement;
    field.value = `work laptop`;
    field.dispatchEvent(new Event(`input`));
    registerPasskey.mockResolvedValue({ passkey: {}, session: SESSION });
    buttonSaying(`Add a passkey`)?.click();
    await settle();

    expect(registerPasskey).toHaveBeenCalledWith(TARGET, `google-proof`, `work laptop`);
    await expect(outcome).resolves.toEqual(SESSION);
});

it(`a refused ceremony is said on the card and the prompt stands, so the person can try again`, async () => {
    needsSignIn.value = false;
    const outcome = raiseSignIn({ kind: `step-up`, target: TARGET, enrolled: true, bearer: `google-proof` });
    const el = await mount();
    signInWithPasskey.mockRejectedValue(new Error(`signature counter did not advance`));
    buttonSaying(`Use your passkey`)?.click();
    await settle();

    expect(el.textContent).toContain(`The passkey sign-in didn't complete.`);
    expect(el.textContent).toContain(`signature counter did not advance`);
    expect(buttonSaying(`Use your passkey`)?.disabled).toBe(false);

    dismissSignIn();
    await expect(outcome).resolves.toBeUndefined();
});

it(`only the owner is offered a recovery code, and it is spent under the proof that was taken`, async () => {
    needsSignIn.value = false;
    activeSandbox.value = { role: `collaborator` };
    void raiseSignIn({ kind: `step-up`, target: TARGET, enrolled: true, bearer: `google-proof` });
    let el = await mount();
    expect(el.textContent).not.toContain(`recovery code`);
    dismissSignIn();
    app?.unmount();
    document.body.innerHTML = ``;

    activeSandbox.value = { role: `owner` };
    const outcome = raiseSignIn({ kind: `step-up`, target: TARGET, enrolled: true, bearer: `google-proof` });
    el = await mount();
    expect(el.textContent).toContain(`recovery code`);
    const field = el.querySelector(`input[placeholder^="xxxxx"]`) as HTMLInputElement;
    field.value = `abcde-fghjk-mnpqr-stuvw`;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
    recoverWithCode.mockResolvedValue({ ...SESSION, remaining: 7 });
    buttonSaying(`Use code`)?.click();
    await settle();

    expect(recoverWithCode).toHaveBeenCalledWith(TARGET, `google-proof`, `abcde-fghjk-mnpqr-stuvw`);
    await expect(outcome).resolves.toEqual(expect.objectContaining({ ...SESSION, remaining: 7 }));
});

it(`back to setup settles both roads with nothing`, async () => {
    const outcome = raiseSignIn({ kind: `choose`, target: TARGET, passkey: true });
    await mount();
    buttonSaying(`Back to setup`)?.click();
    await settle();

    expect(cancelSignIn).toHaveBeenCalledTimes(1);
    await expect(outcome).resolves.toBeUndefined();
});
