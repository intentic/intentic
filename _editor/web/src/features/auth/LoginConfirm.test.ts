// The page a sign-in mail's link lands on. Mail scanners fetch every link in a message, so the page must spend nothing
// on load: it names the address, takes the code out of the address bar, and signs in only on a press. A code that no
// longer signs in is one mail away, to the same address.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { installI18n } from "@intentic/ui/i18n";
import * as actualVueRouter from "vue-router";

// Mounting reads matchMedia (ui) and window.env (environment.ts) at module scope; see Setup.test.ts.

const replace = jest.fn();
// What the mail's link carried.
const query = ref<Record<string, string>>({});
jest.mock(`vue-router`, () => ({
    ...actualVueRouter,
    // SAFETY: the page reads nothing of the router but `replace`, and nothing of the route but its query.
    useRouter: () => ({ push: jest.fn(), replace }) as never,
    // SAFETY: as above, the query alone.
    useRoute: () =>
        ({
            get query() {
                return query.value;
            },
        }) as never,
}));

const signInWithEmailCode = jest.fn<(email: string, otp: string) => Promise<void>>();
const sendEmailCode = jest.fn<(email: string) => Promise<void>>();
jest.mock(`../../client/auth/useAuth`, () => ({ useAuth: () => ({ user: ref(null), signInWithEmailCode, sendEmailCode }) }));

const { default: LoginConfirm } = await import("./LoginConfirm.vue");
const { EmailCodeError } = await import("../../client/auth/emailCode");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(LoginConfirm) });
    app.component(`Icon`, IconStub);
    // The address is slotted into its sentence (`<i18n-t>`), which the plugin registers.
    installI18n(app);
    app.mount(el);
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    return el;
};

const button = (label: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.includes(label));

const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
};

beforeEach(() => {
    query.value = { email: `Ana@Corp.example`, code: `123456`, returnTo: `/sandbox/usage` };
    replace.mockReset();
    signInWithEmailCode.mockReset().mockResolvedValue(undefined);
    sendEmailCode.mockReset().mockResolvedValue(undefined);
    globalThis.history.replaceState(null, ``, `/login/confirm?email=ana%40corp.example&code=123456&returnTo=%2Fsandbox%2Fusage`);
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`names the address and spends nothing on load, with the code gone from the address bar`, async () => {
    const el = await mount();

    expect(el.textContent).toContain(`Sign in to intentic as ana@corp.example?`);
    expect(signInWithEmailCode).not.toHaveBeenCalled();
    expect(`${globalThis.location.pathname}${globalThis.location.search}`).toBe(`/login/confirm`);
});

it(`signs in on the press with the code the link carried, then lands where the link said`, async () => {
    await mount();

    button(`Confirm and sign in`)?.click();
    await settle();

    expect(signInWithEmailCode).toHaveBeenCalledWith(`ana@corp.example`, `123456`);
    expect(replace).toHaveBeenCalledWith(`/sandbox/usage`);
});

// The same rule /login holds: a destination off this origin is an open redirect waiting for a link to carry it.
it(`refuses a destination that leaves this origin`, async () => {
    query.value = { ...query.value, returnTo: `//evil.example` };
    await mount();

    button(`Confirm and sign in`)?.click();
    await settle();

    expect(replace).toHaveBeenCalledWith(`/`);
});

it(`offers a fresh code to the same address when this one no longer signs in`, async () => {
    signInWithEmailCode.mockRejectedValueOnce(new EmailCodeError(`expired`, `That code has run out. Send a new one.`));
    const el = await mount();

    button(`Confirm and sign in`)?.click();
    await settle();

    expect(el.textContent).toContain(`That code has run out. Send a new one.`);
    expect(replace).not.toHaveBeenCalled();
    button(`Email me a sign-in code`)?.click();
    await settle();

    expect(sendEmailCode).toHaveBeenCalledWith(`ana@corp.example`);
    // The address is the link's, never another: there is no field to change it in.
    expect(document.querySelector(`input[type="email"]`)).toBeNull();
});

it(`keeps the press for another try when the platform could not be asked`, async () => {
    signInWithEmailCode.mockRejectedValueOnce(new EmailCodeError(`failed`, `the platform is down`));
    const el = await mount();

    button(`Confirm and sign in`)?.click();
    await settle();

    expect(el.textContent).toContain(`the platform is down`);
    expect(button(`Confirm and sign in`)?.disabled).toBe(false);
});

it(`sends a link that lost a part back to the sign-in page, with nothing to confirm`, async () => {
    query.value = { email: `ana@corp.example`, code: `12` };
    const el = await mount();

    expect(el.textContent).toContain(`This sign-in link is incomplete.`);
    expect(button(`Confirm and sign in`)).toBeUndefined();
});
