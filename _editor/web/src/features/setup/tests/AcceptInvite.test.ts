// The invite's landing for somebody signed out: both ways in, as the invited address and no other, with the terms on
// screen before anything is sent. The platform accepts the invite only for that address, so the code road offers no
// field to type a different one into.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { installI18n } from "@intentic/ui/i18n";
import * as actualVueRouter from "vue-router";
import * as actualDesktop from "../../../app/environments/desktop";

// Mounting reads matchMedia (ui) and window.env (environment.ts) at module scope; see Setup.test.ts.

jest.mock(`vue-router`, () => ({
    ...actualVueRouter,
    // SAFETY: the page reads nothing of the router but push/replace, and nothing of the route but its token.
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) as never,
    // SAFETY: as above, the token alone.
    useRoute: () => ({ params: { token: `tok-1` } }) as never,
}));
const preview = jest.fn(async () => ({ status: `pending`, invitedEmail: `ana@corp.example`, sandboxName: `notes`, role: `collaborator` }));
jest.mock(`../../../lib/useApi`, () => ({ apiClient: { invite: { preview: () => preview(), accept: jest.fn() } } }));
const signInWithGoogle = jest.fn<(path?: string) => Promise<void>>().mockResolvedValue(undefined);
const sendEmailCode = jest.fn<(email: string) => Promise<void>>().mockResolvedValue(undefined);
jest.mock(`../../../client/auth/useAuth`, () => ({
    useAuth: () => ({
        user: ref(null),
        refresh: jest.fn(async () => null),
        signInWithGoogle,
        signOut: jest.fn(),
        sendEmailCode,
        signInWithEmailCode: jest.fn(),
    }),
}));
jest.mock(`../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ refresh: jest.fn(), select: jest.fn() }) }));
// An ordinary browser. Partial, over the real module, for Login.test.ts's reason.
jest.mock(`../../../app/environments/desktop`, () => ({ ...actualDesktop, desktopVersion: () => undefined }));
const GOOGLE_ONLY = { google: true, email: false };
const readSignInOptions = jest.fn<() => Promise<{ google: boolean; email: boolean }>>();
jest.mock(`../../auth/signInOptions`, () => ({ GOOGLE_ONLY, readSignInOptions: () => readSignInOptions() }));

const { default: AcceptInvite } = await import("../AcceptInvite.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(AcceptInvite) });
    app.component(`Icon`, IconStub);
    // The invite's sentences slot the sandbox and the address in (`<i18n-t>`), which the plugin registers.
    installI18n(app);
    app.mount(el);
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    return el;
};

const button = (label: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.includes(label));

beforeEach(() => {
    readSignInOptions.mockReset().mockResolvedValue({ google: true, email: true });
    signInWithGoogle.mockClear();
    sendEmailCode.mockClear();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`offers both ways in as the invited address, with the terms on screen`, async () => {
    const el = await mount();

    expect(el.textContent).toContain(`Sign in as ana@corp.example to continue.`);
    expect(button(`Continue with Google`)).toEqual(expect.any(HTMLButtonElement));
    expect(button(`Email me a sign-in code`)).toEqual(expect.any(HTMLButtonElement));
    expect(el.textContent).toContain(`By continuing you agree to our`);
    // The invite is the platform's for this address alone: no field to type another into.
    expect(document.querySelector(`input[type="email"]`)).toBeNull();
});

it(`mails the code to the invited address`, async () => {
    await mount();

    button(`Email me a sign-in code`)?.click();
    await new Promise((resolve) => setTimeout(resolve));

    expect(sendEmailCode).toHaveBeenCalledWith(`ana@corp.example`);
});

it(`keeps Google's own words where Google is the only way in`, async () => {
    readSignInOptions.mockResolvedValue(GOOGLE_ONLY);
    const el = await mount();

    expect(el.textContent).toContain(`Sign in with Google as ana@corp.example to continue.`);
    expect(button(`Email me a sign-in code`)).toBeUndefined();
});
