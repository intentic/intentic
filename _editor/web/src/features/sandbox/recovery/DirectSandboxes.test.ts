// The outage screen's way through on a device that remembers no account: the platform is down, so who is opening the
// sandbox has to come from the sandbox side. A session this browser already holds there names them; otherwise they
// are asked, and an account with no Google sign-in has a passkey registered with the sandbox as its one way in.
import "@intentic/testing/dom";
import type { DaemonSession } from "@intentic/sandbox-contract/schemas/system";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as actualVueRouter from "vue-router";
import type { RememberedAccount, RememberedSandbox } from "../../../client/directory/deviceDirectory";
import * as actualDirectMode from "./directMode";

// Mounting reads matchMedia (ui) and window.env (environment.ts) at module scope; see Setup.test.ts.

const replace = jest.fn();
jest.mock(`vue-router`, () => ({
    ...actualVueRouter,
    // SAFETY: the screen reads nothing of the router but `replace`.
    useRouter: () => ({ replace }) as never,
}));
const getIdToken = jest.fn<() => Promise<string | undefined>>();
jest.mock(`../../../client/auth/useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ getIdToken: () => getIdToken() }) }));
jest.mock(`../../../client/endpoint/endpoint`, () => ({ healthAnswers: async () => true }));
// A device that remembers no account: the platform was down before this one ever listed.
jest.mock(`../../../client/directory/deviceDirectory`, () => ({ rememberedAccount: () => undefined }));
const heldSessionEmail = jest.fn<(sandboxId: string) => string | undefined>();
const adoptSession = jest.fn<(sandboxId: string, session: DaemonSession) => void>();
jest.mock(`../../../client/session/sandboxSession`, () => ({
    useSandboxSession: () => ({ heldSessionEmail: (id: string) => heldSessionEmail(id), adoptSession: (id: string, session: DaemonSession) => adoptSession(id, session) }),
}));
const signInWithPasskey = jest.fn<(target: unknown) => Promise<DaemonSession>>();
jest.mock(`../../../client/session/passkeySignIn`, () => ({ browserSupportsPasskeys: () => true, signInWithPasskey: (target: unknown) => signInWithPasskey(target) }));
const enterDirectMode = jest.fn<(account: RememberedAccount, sandbox: RememberedSandbox) => void>();
// Partial, over the real module: naming the account and the linked sandbox are its own, only the switch is watched.
jest.mock(`./directMode`, () => ({
    ...actualDirectMode,
    enterDirectMode: (account: RememberedAccount, sandbox: RememberedSandbox) => enterDirectMode(account, sandbox),
}));

const { default: DirectSandboxes } = await import("./DirectSandboxes.vue");

const LINK = `https://sandbox-8a8171848c91.sbx.intentic.dev`;

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(DirectSandboxes, { focusUrl: LINK }) });
    app.component(`Icon`, IconStub);
    app.mount(el);
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    return el;
};

const button = (label: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim() === label);

const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
};

beforeEach(() => {
    replace.mockReset();
    getIdToken.mockReset().mockResolvedValue(undefined);
    heldSessionEmail.mockReset().mockReturnValue(undefined);
    adoptSession.mockReset();
    signInWithPasskey.mockReset();
    enterDirectMode.mockReset();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`opens at once as the account a session held on the sandbox names, asking nothing`, async () => {
    heldSessionEmail.mockReturnValue(`ana@corp.example`);
    await mount();

    button(`Open`)?.click();
    await settle();

    expect(enterDirectMode.mock.calls[0]?.[0]?.user.email).toBe(`ana@corp.example`);
    expect(getIdToken).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith(`/`);
});

it(`asks how to sign in rather than putting Google's prompt up unasked`, async () => {
    const el = await mount();

    button(`Open`)?.click();
    await settle();

    expect(getIdToken).not.toHaveBeenCalled();
    expect(el.textContent).toContain(`This device doesn't remember your account.`);
    expect(button(`Continue with Google`)).toEqual(expect.any(HTMLButtonElement));
    expect(button(`Use a passkey`)).toEqual(expect.any(HTMLButtonElement));
});

// The passkey is the sandbox's own way to know its reader, so it needs no platform: the session it mints is kept under
// the id the window opens the sandbox by, and names the account.
it(`opens with a passkey registered with the sandbox, keeping the session it mints`, async () => {
    const session: DaemonSession = { token: `sess-passkey`, expiresAt: 4_102_444_800_000, email: `ana@corp.example` };
    signInWithPasskey.mockResolvedValue(session);
    await mount();
    button(`Open`)?.click();
    await settle();

    button(`Use a passkey`)?.click();
    await settle();

    expect(signInWithPasskey).toHaveBeenCalledWith({ sandboxId: `direct:sandbox-8a8171848c91.sbx.intentic.dev`, base: LINK, connectToken: undefined });
    expect(adoptSession).toHaveBeenCalledWith(`direct:sandbox-8a8171848c91.sbx.intentic.dev`, session);
    expect(enterDirectMode.mock.calls[0]?.[0]?.user.email).toBe(`ana@corp.example`);
    expect(replace).toHaveBeenCalledWith(`/`);
});

it(`says a passkey that did not open it, and opens nothing`, async () => {
    signInWithPasskey.mockRejectedValue(new Error(`No passkey is registered for this sandbox here.`));
    const el = await mount();
    button(`Open`)?.click();
    await settle();

    button(`Use a passkey`)?.click();
    await settle();

    expect(el.textContent).toContain(`No passkey is registered for this sandbox here.`);
    expect(enterDirectMode).not.toHaveBeenCalled();
});
