// @vitest-environment jsdom
// The Passkeys group on the Access tab: whose passkeys are listed, how one is added (and the upgraded session kept),
// and the owner's require switch with the recovery codes it hands out once.
import PrimeVue from "primevue/config";
import { afterEach, expect, it, vi } from "vitest";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Import chain touches a media query (UI barrel's useDevice) at module eval; hence jsdom.

const OWN = { id: `own-1`, email: `owner@example.com`, label: `work laptop`, rpId: `app.test`, createdAt: Date.parse(`2026-09-01T00:00:00Z`), backedUp: true };
const THEIRS = { id: `member-1`, email: `member@example.com`, label: `phone`, rpId: `app.test`, createdAt: Date.parse(`2026-09-02T00:00:00Z`), backedUp: false };

const state = vi.hoisted(() => ({
    list: { passkeys: [] as unknown[], required: false, recovery: undefined as { remaining: number } | undefined },
    calls: [] as { path: string; init?: RequestInit }[],
    adopted: [] as unknown[],
    supported: true,
}));

vi.mock(`../client/sandboxClient`, () => ({
    sandboxJson: async (path: string, init?: RequestInit) => {
        state.calls.push({ path, init });
        if (path === `/system/passkeys` && init === undefined) {
            return state.list;
        }
        if (path === `/system/passkeys/register/options`) {
            return { rp: { id: `app.test` }, challenge: `AQ` };
        }
        if (path === `/system/passkeys/register`) {
            return { passkey: OWN, session: { token: `sess-up`, expiresAt: 1, email: `owner@example.com` } };
        }
        if (path === `/system/passkeys/policy`) {
            const required = (JSON.parse(String(init?.body)) as { required: boolean }).required;
            return required ? { required, codes: [`abcde-fghjk-mnpqr-stuvw`, `bcdef-ghjkm-npqrs-tuvwx`] } : { required };
        }
        return { ok: true };
    },
}));
vi.mock(`../client/passkeySignIn`, () => ({
    browserSupportsPasskeys: () => state.supported,
    createPasskey: async (options: { challenge: string }) => ({ id: `new`, rawId: `new`, type: `public-key`, response: { clientDataJSON: options.challenge, attestationObject: `AA` } }),
}));
vi.mock(`../client/sandboxSession`, () => ({ useSandboxSession: () => ({ adoptSession: (...args: unknown[]) => state.adopted.push(args) }) }));
vi.mock(`../../auth/useAuth`, () => ({ useAuth: () => ({ user: ref({ email: `owner@example.com` }) }) }));
const role = ref<`owner` | `viewer`>(`owner`);
vi.mock(`../client/useSandbox`, () => ({ useSandbox: () => ({ active: computed(() => ({ id: `s1`, name: `work`, role: role.value })) }) }));

const { default: PasskeysSection } = await import("./PasskeysSection.vue");

let app: App | undefined;
const mount = async (): Promise<void> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(PasskeysSection) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.mount(el);
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
};

const shown = (): string => document.body.textContent ?? ``;
const buttonLabelled = (label: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label);
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
};

afterEach(() => {
    state.list = { passkeys: [], required: false, recovery: undefined };
    state.calls = [];
    state.adopted = [];
    state.supported = true;
    role.value = `owner`;
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`lists every passkey the daemon returned, naming another member's, and removes one on request`, async () => {
    state.list = { passkeys: [OWN, THEIRS], required: false, recovery: undefined };
    await mount();

    expect(shown()).toContain(`work laptop`);
    expect(shown()).toContain(`added Sep 1, 2026 · never used · app.test`);
    expect(shown()).toContain(`synced`);
    expect(shown()).toContain(`member@example.com`);

    const removes = [...document.body.querySelectorAll(`button`)].filter((button) => button.textContent?.trim() === `Remove`);
    removes[1]?.click();
    await settle();
    expect(state.calls.map((call) => [call.path, call.init?.method])).toContainEqual([`/system/passkeys/member-1`, `DELETE`]);
});

it(`adds a passkey through the ceremony, sends the label, and keeps the upgraded session`, async () => {
    await mount();
    // An account with no passkey yet: the list says nothing, so the form is the whole empty state, and the label
    // the ceremony below adds cannot already be on screen.
    expect(buttonLabelled(`Add a passkey`)?.disabled).toBe(false);
    expect(shown()).not.toContain(`work laptop`);

    const field = document.body.querySelector(`input[type=text]`) as HTMLInputElement;
    field.value = `  work laptop `;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
    document.body.querySelector(`form`)?.dispatchEvent(new Event(`submit`));
    await settle();
    await settle();

    const register = state.calls.find((call) => call.path === `/system/passkeys/register`);
    expect(JSON.parse(String(register?.init?.body))).toEqual({
        response: { id: `new`, rawId: `new`, type: `public-key`, response: { clientDataJSON: `AQ`, attestationObject: `AA` } },
        label: `work laptop`,
    });
    expect(state.adopted).toEqual([[`s1`, { token: `sess-up`, expiresAt: 1, email: `owner@example.com` }]]);
});

it(`says so, and disables adding, in a browser without WebAuthn`, async () => {
    state.supported = false;
    await mount();
    expect(shown()).toContain(`This browser can't create passkeys`);
    expect(buttonLabelled(`Add a passkey`)?.disabled).toBe(true);
});

it(`the owner's require switch needs a passkey of their own, then hands out the codes once`, async () => {
    await mount();
    // cea5b261a ("fix: redundant texts") deleted the sentence that spelled this out, so the disabled switch — still
    // labelled as the affordance to turn requiring ON, beside an `optional` state — is the whole refusal now.
    expect(buttonLabelled(`Require a passkey`)?.disabled).toBe(true);
    expect(shown()).toContain(`Off. A Google sign-in opens the sandbox`);
    app?.unmount();
    document.body.innerHTML = ``;

    state.list = { passkeys: [OWN], required: false, recovery: undefined };
    await mount();
    const require = buttonLabelled(`Require a passkey`);
    expect(require?.disabled).toBe(false);
    // The daemon reads back as required once the switch lands, as the real one would.
    state.list = { passkeys: [OWN], required: true, recovery: { remaining: 8 } };
    require?.click();
    await settle();
    await settle();

    expect(JSON.parse(String(state.calls.find((call) => call.path === `/system/passkeys/policy`)?.init?.body))).toEqual({ required: true });
    expect(shown()).toContain(`Save these now.`);
    expect(shown()).toContain(`8 unused`);
    expect(buttonLabelled(`Stop requiring`)?.disabled).toBe(false);
});

it(`a member sees their own passkeys and no switch`, async () => {
    role.value = `viewer`;
    state.list = { passkeys: [THEIRS], required: true, recovery: undefined };
    await mount();
    expect(shown()).toContain(`phone`);
    expect(shown()).not.toContain(`Require a passkey`);
    expect(shown()).not.toContain(`Recovery codes`);
});
