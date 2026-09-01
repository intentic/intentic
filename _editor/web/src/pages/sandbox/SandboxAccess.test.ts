// @vitest-environment jsdom
//
// jsdom because the subject is WHAT THE TAB SAYS AFTER AN INVITE, and that sentence was the bug.
//
// Inviting is two writes: the daemon's enforced list, then the platform's record + email, and they used to
// share one catch, with one sentence: "Couldn't send the invite, is the sandbox online?". So a platform-side
// failure accused a sandbox that had just answered, and a REFUSED EMAIL (the whole request 500'd on it) read as
// an invite that never happened, over a roster already showing the person pending. Nothing on screen could tell
// those three apart, which is why they are three tests.
import PrimeVue from "primevue/config";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// What this component's import chain reads at module eval: the app's environment (the API client) and a media
// query (the UI barrel's useDevice), exactly as DesktopSyncCard.test.ts cuts the same edge.

const sandboxJson = vi.fn(async () => ({ members: [] }));
vi.mock(`../../composables/sandbox/sandboxClient`, () => ({ sandboxJson: (...args: unknown[]) => sandboxJson(...(args as [])) }));

const create = vi.fn();
const list = vi.fn(async () => ({ members: [] }));
vi.mock(`../../composables/useApi`, () => ({ apiClient: { invite: { list: () => list(), create: (...a: unknown[]) => create(...a) } } }));

vi.mock(`../../composables/useAuth`, () => ({ useAuth: () => ({ user: ref({ email: `owner@example.com` }) }) }));
vi.mock(`../../composables/sandbox/useSandbox`, () => ({
    useSandbox: () => ({ active: ref({ name: `radarsu-mig`, role: `owner` }), activeSandboxId: ref(`s1`) }),
}));
vi.mock(`../../composables/sandbox/useSandboxOutline`, () => ({ useSandboxOutline: () => false }));
vi.mock(`../../composables/usePresence`, () => ({ presenceOthers: [], presenceActivity: () => `` }));
// The session module reaches Google Identity Services and localStorage at module eval; the tab only needs the
// one fact it exports, this browser's pass expiry. Fixed so the rendered date is the same in every timezone.
const sessionExpiresAt = ref<number | undefined>(Date.parse(`2026-09-24T12:00:00.000Z`));
vi.mock(`../../composables/sandbox/sandboxSession`, () => ({ useSandboxSession: () => ({ sessionExpiresAt }) }));

const { default: SandboxAccess } = await import("./SandboxAccess.vue");

let app: App | undefined;
const mount = (): void => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxAccess) });
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.mount(el);
};

const shown = (): string => document.body.textContent ?? ``;

// Fill the address and submit the form the way the owner does.
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
    create.mockReset();
    list.mockReset();
    list.mockResolvedValue({ members: [] });
    sessionExpiresAt.value = Date.parse(`2026-09-24T12:00:00.000Z`);
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// The sandbox is the ONLY one of the two writes that can be offline, and it is the one that failed here.
it(`blames the sandbox only when the sandbox is what failed`, async () => {
    sandboxJson.mockRejectedValue(new Error(`Request failed (500).`));
    mount();
    await inviteEmail(`guest@example.com`);

    expect(shown()).toContain(`Couldn't grant access on the sandbox`);
    // Nothing was recorded, because the enforcer never took the grant.
    expect(create).not.toHaveBeenCalled();
});

// The mirror image, and the one the owner reported: the sandbox answered, the platform did not.
it(`does not ask whether the sandbox is online when the platform is what failed`, async () => {
    create.mockRejectedValue(new Error(`Internal server error`));
    mount();
    await inviteEmail(`guest@example.com`);

    expect(shown()).not.toMatch(/online\?/);
    expect(shown()).toContain(`recording the invite failed`);
});

/* An invite whose mail could not travel is still an invite. The link comes back with the roster, so the owner
 * can hand it over, which is the only way this works at all on a platform served at localhost. */
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

/* And when the provider REFUSED it, what it said is on the card. The owner's platform is the owner's to fix:
 * a quota, a key, an unverified domain, and none of that is actionable from "internal server error". */
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

/* "Signed-in browsers" was a plural heading over a lone red button, so it read as a roster with nothing in it,
 * and the honest reading of an empty roster is that no browser is signed in and the button is pointless. No
 * roster can exist (sessions are verified, not stored), so the group has to say what IS true: this browser,
 * which it can name because it is running in it, and why the rest are unlistable. */
it(`names this browser and says why the others cannot be listed`, async () => {
    mount();
    await nextTick();

    expect(shown()).toContain(`This browser`);
    expect(shown()).toContain(`owner@example.com · signed in until Sep 24, 2026`);
    expect(shown()).toContain(`Other browsers aren't listed`);
    expect(shown()).toMatch(/doesn't track devices/);
});

// A daemon predating the session exchange hands out no pass to quote an expiry for. Still signed in, and the
// row must not invent a date or render "until undefined".
it(`says only that this browser is signed in when there is no pass to date`, async () => {
    sessionExpiresAt.value = undefined;
    mount();
    await nextTick();

    expect(shown()).toContain(`owner@example.com · signed in`);
    expect(shown()).not.toMatch(/signed in until/);
});

/* One click used to sign every person in the sandbox out, with no undo and no aim. It is armed first now, the
 * same two-step inline confirm as account deletion, and the arming step must not fire the request. */
it(`arms sign-out-everywhere before firing it, and says who it hits`, async () => {
    mount();
    await nextTick();

    buttonLabelled(`Sign out all browsers`)?.click();
    await nextTick();
    expect(sandboxJson).not.toHaveBeenCalled();
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
    // Two buttons carry the label once armed (the row's, now hidden, and the confirm's): the live one is last.
    const confirm = [...document.body.querySelectorAll(`button`)].findLast((button) => button.textContent?.trim() === `Sign out all browsers`);
    confirm?.click();
    await nextTick();
    await nextTick();

    expect(sandboxJson).toHaveBeenCalledWith(`/system/sessions/revoke`, { method: `POST` });
    expect(shown()).toContain(`Every browser has been signed out`);
});
