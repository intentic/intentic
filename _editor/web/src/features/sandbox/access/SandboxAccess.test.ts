// @vitest-environment jsdom
// Access tab's rendered text after an invite: which of its two writes (daemon grant, platform record/email) failed, and
// refusal vs silence, must all read differently on screen.
import PrimeVue from "primevue/config";
import { afterEach, expect, it, vi } from "vitest";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Import chain touches the API client and a media query (UI barrel's useDevice) at module eval; hence jsdom.

const sandboxJson = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ members: [] }));
vi.mock(`../client/sandboxClient`, () => ({ sandboxJson: (...args: unknown[]) => sandboxJson(...(args as [])) }));

const create = vi.fn();
const list = vi.fn(async () => ({ members: [] }));
vi.mock(`../../../lib/useApi`, () => ({ apiClient: { invite: { list: () => list(), create: (...a: unknown[]) => create(...a) } } }));

vi.mock(`../../auth/useAuth`, () => ({ useAuth: () => ({ user: ref({ email: `owner@example.com` }) }) }));
const role = ref<`owner` | `viewer`>(`owner`);
vi.mock(`../client/useSandbox`, () => ({
    useSandbox: () => ({
        active: computed(() => ({ name: `radarsu-mig`, role: role.value })),
        activeSandboxId: ref(`s1`),
        daemonUrl: ref(`https://sandbox-abc.example.test`),
    }),
}));
vi.mock(`../overview/useSandboxOutline`, () => ({ useSandboxOutline: () => false }));
vi.mock(`../../../shell/presence/usePresence`, () => ({ presenceOthers: [], presenceActivity: () => `` }));
// Session module touches GIS/localStorage at eval; needs only its expiry. Fixed date avoids timezone drift.
const sessionExpiresAt = ref<number | undefined>(Date.parse(`2026-09-24T12:00:00.000Z`));
vi.mock(`../client/sandboxSession`, () => ({ useSandboxSession: () => ({ sessionExpiresAt }) }));

const { default: SandboxAccess } = await import("./SandboxAccess.vue");

let app: App | undefined;
const mount = (): void => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxAccess) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.mount(el);
};

const shown = (): string => document.body.textContent ?? ``;

const inviteEmail = async (address: string): Promise<void> => {
    const field = document.body.querySelector(`input[type=email]`) as HTMLInputElement;
    field.value = address;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
    document.body.querySelector(`form`)?.dispatchEvent(new Event(`submit`));
    await nextTick();
    await nextTick();
    await nextTick();
};

const buttonLabelled = (label: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label);

afterEach(() => {
    sandboxJson.mockReset();
    sandboxJson.mockResolvedValue({ members: [] });
    role.value = `owner`;
    create.mockReset();
    list.mockReset();
    list.mockResolvedValue({ members: [] });
    sessionExpiresAt.value = Date.parse(`2026-09-24T12:00:00.000Z`);
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`blames the sandbox only when the sandbox is what failed`, async () => {
    sandboxJson.mockRejectedValue(new Error(`Request failed (500).`));
    mount();
    await inviteEmail(`guest@example.com`);

    expect(shown()).toContain(`Couldn't grant access on the sandbox`);
    expect(create).not.toHaveBeenCalled();
});

it(`does not ask whether the sandbox is online when the platform is what failed`, async () => {
    create.mockRejectedValue(new Error(`Internal server error`));
    mount();
    await inviteEmail(`guest@example.com`);

    expect(shown()).not.toMatch(/online\?/);
    expect(shown()).toContain(`recording the invite failed`);
});

it(`hands the owner the link when the email did not carry it`, async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis.navigator, `clipboard`, { value: { writeText }, configurable: true });
    create.mockResolvedValue({
        members: [{ email: `guest@example.com`, role: `collaborator`, status: `pending`, invitedAt: `2026-08-18T00:00:00.000Z` }],
        link: `https://localhost:47145/invite/tok`,
        delivery: `local-link`,
    });
    mount();
    await inviteEmail(`guest@example.com`);

    expect(shown()).toContain(`Invited.`);
    expect(shown()).toContain(`https://localhost:47145/invite/tok`);

    const copy = [...document.body.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Copy link`);
    copy?.click();
    await nextTick();
    expect(writeText).toHaveBeenCalledWith(`https://localhost:47145/invite/tok`);
});

it(`shows what the mail provider said when it refused`, async () => {
    create.mockResolvedValue({
        members: [],
        link: `https://app.test/invite/tok`,
        delivery: `refused`,
        reason: `Resend rejected the email (429): daily quota reached`,
    });
    mount();
    await inviteEmail(`guest@example.com`);

    expect(shown()).toContain(`The email was refused`);
    expect(shown()).toContain(`daily quota reached`);
    expect(shown()).toContain(`https://app.test/invite/tok`);
});

it(`names this browser and says why the others cannot be listed`, async () => {
    mount();
    await nextTick();

    expect(shown()).toContain(`This browser`);
    expect(shown()).toContain(`owner@example.com · signed in until Sep 24, 2026`);
    expect(shown()).toContain(`Other browsers aren't listed`);
    expect(shown()).toMatch(/doesn't track devices/);
});

// undefined pass expiry means a daemon predating the session exchange, not merely absent.
it(`says only that this browser is signed in when there is no pass to date`, async () => {
    sessionExpiresAt.value = undefined;
    mount();
    await nextTick();

    expect(shown()).toContain(`owner@example.com · signed in`);
    expect(shown()).not.toMatch(/signed in until/);
});

it(`arms sign-out-everywhere before firing it, and says who it hits`, async () => {
    mount();
    await nextTick();

    buttonLabelled(`Sign out all browsers`)?.click();
    await nextTick();
    expect((sandboxJson.mock.calls as unknown[][]).some(([, init]) => (init as { method?: string } | undefined)?.method === `POST`)).toBe(false);
    expect(shown()).toContain(`has to sign in again`);

    buttonLabelled(`Cancel`)?.click();
    await nextTick();
    expect(shown()).not.toContain(`has to sign in again`);
});

it(`revokes only on the confirming click, then reports it`, async () => {
    mount();
    await nextTick();

    buttonLabelled(`Sign out all browsers`)?.click();
    await nextTick();
    // Two buttons share this label once armed; the confirm's is last.
    const confirm = [...document.body.querySelectorAll(`button`)].findLast((button) => button.textContent?.trim() === `Sign out all browsers`);
    confirm?.click();
    await nextTick();
    await nextTick();

    expect(sandboxJson).toHaveBeenCalledWith(`/system/sessions/revoke`, { method: `POST` });
    expect(shown()).toContain(`Every browser has been signed out`);
});

it(`mints an API token as the owner and shows it once with its snippet`, async () => {
    sandboxJson.mockImplementation(async (path: unknown, init?: unknown) => {
        if (path === `/system/control/tokens` && (init as { method?: string } | undefined)?.method === `POST`) {
            return { id: `ct-1`, token: `ict_shown-once` };
        }
        if (path === `/system/control/tokens`) {
            return { tokens: [{ id: `ct-1`, label: `nightly CI`, scope: `read`, createdAt: Date.parse(`2026-09-01T00:00:00Z`), createdBy: `owner@example.com` }] };
        }
        return { members: [], automations: [], workflows: [], repos: [] };
    });
    mount();
    await nextTick();
    await nextTick();
    expect(shown()).toContain(`API tokens`);
    expect(shown()).toContain(`nightly CI`);
    expect(shown()).toContain(`never used`);

    buttonLabelled(`Mint token`)?.click();
    await nextTick();
    await nextTick();
    expect(shown()).toContain(`ict_shown-once`);
    expect(shown()).toContain(`Shown once`);
    const mintCall = (sandboxJson.mock.calls as unknown[][]).find(
        ([path, init]) => path === `/system/control/tokens` && (init as { method?: string } | undefined)?.method === `POST`,
    );
    if (mintCall === undefined) {
        throw new Error(`no mint request reached the sandbox`);
    }
    const body = JSON.parse((mintCall[1] as { body: string }).body) as { scope: string; expiresAt?: number };
    expect(body.scope).toBe(`read`);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
});

it(`keeps the token surfaces off a member's tab`, async () => {
    role.value = `viewer`;
    mount();
    await nextTick();
    expect(shown()).not.toContain(`API tokens`);
    expect(shown()).not.toContain(`Other ways in`);
});
