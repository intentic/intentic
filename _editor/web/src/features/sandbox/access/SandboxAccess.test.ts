// Access tab's rendered text after an invite: which of its two writes (daemon grant, platform record/email) failed, and
// refusal vs silence, must all read differently on screen.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { it, expect, afterEach, mock } from "bun:test";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { formatDate } from "@intentic/ui/format";

// Import chain touches the API client and a media query (UI barrel's useDevice) at module eval; hence jsdom.

const sandboxJson = mock(async (..._args: unknown[]): Promise<unknown> => ({ members: [] }));
mock.module(`../client/sandboxClient`, () => ({ sandboxJson: (...args: unknown[]) => sandboxJson(...(args as [])) }));

const create = mock();
const list = mock(async (): Promise<{ members: unknown[] }> => ({ members: [] }));
const setRole = mock();
mock.module(`../../../lib/useApi`, () => ({
    apiClient: { invite: { list: () => list(), create: (...a: unknown[]) => create(...a), setRole: (...a: unknown[]) => setRole(...a) } },
}));

mock.module(`../../auth/useAuth`, () => ({ useAuth: () => ({ user: ref({ email: `owner@example.com` }) }) }));
const role = ref<`owner` | `viewer`>(`owner`);
mock.module(`../client/useSandbox`, () => ({
    useSandbox: () => ({
        active: computed(() => ({ name: `radarsu-mig`, role: role.value })),
        activeSandboxId: ref(`s1`),
        daemonUrl: ref(`https://sandbox-abc.example.test`),
    }),
}));
mock.module(`../overview/useSandboxOutline`, () => ({ useSandboxOutline: () => false }));
// One assistant, homed in the support folder: which areas hand it over is read off where it starts, never picked.
const personas = ref([{ id: `support`, label: `Support`, capabilities: [], workspace: { startIn: `support` } }]);
mock.module(`../personas/usePersonas`, () => ({ usePersonas: () => ({ personas, connected: ref([]), isConnected: () => false }) }));
// Two named parts of the workspace: one the assistant above works in, one nobody works in — the two answers a fence
// can give.
const areas = ref([
    { id: `support`, label: `Support guest`, folders: [`support`] },
    { id: `finance`, label: `Finance`, folders: [`finance`] },
]);
mock.module(`../areas/useAreas`, () => ({
    useAreas: () => ({ areas, labelOf: (id: string) => areas.value.find((area) => area.id === id)?.label ?? id }),
}));
mock.module(`../../../shell/presence/usePresence`, () => ({ presenceOthers: [], presenceActivity: () => `` }));
// Session module touches GIS/localStorage at eval; needs only its expiry. Fixed date avoids timezone drift.
const sessionExpiresAt = ref<number | undefined>(Date.parse(`2026-09-24T12:00:00.000Z`));
mock.module(`../session/sandboxSession`, () => ({ useSandboxSession: () => ({ sessionExpiresAt }) }));

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

// Both rosters land on their own promise, so a row exists a few ticks after mount, not on the next one.
const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 5; tick += 1) {
        await nextTick();
    }
};

// Opens a <Picker> by its accessible name and clicks the row whose label starts with `option`. The panel measures
// itself against its trigger on the tick after opening and closes when that comes back empty, as it does in jsdom;
// the pick has to land inside that one tick.
const pick = async (ariaLabel: string, option: string): Promise<void> => {
    document.body.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`)?.click();
    await nextTick();
    [...document.body.querySelectorAll<HTMLButtonElement>(`button[role=option]`)].find((row) => row.textContent?.trim().startsWith(option))?.click();
    await nextTick();
    await nextTick();
    await nextTick();
};

// The daemon roster's every read, and the grant a guest write answers with.
const daemonMembers = mock((): unknown[] => []);

afterEach(() => {
    sandboxJson.mockReset();
    sandboxJson.mockResolvedValue({ members: [] });
    role.value = `owner`;
    create.mockReset();
    setRole.mockReset();
    daemonMembers.mockReset();
    daemonMembers.mockReturnValue([]);
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
    const writeText = mock(async () => undefined);
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
    // The date is formatted through the kit, in the READER's zone, so a fixture at 12:00Z prints as the 24th in
    // Europe and the 25th at UTC+14. Asserted through the same formatter the row uses rather than spelled out: a
    // hardcoded day here tests where the suite runs, not what the row says.
    expect(shown()).toContain(`owner@example.com · signed in until ${formatDate(sessionExpiresAt.value as number)}`);
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
            return {
                tokens: [
                    { id: `ct-1`, label: `nightly CI`, scope: `read`, createdAt: Date.parse(`2026-09-01T00:00:00Z`), createdBy: `owner@example.com` },
                ],
            };
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

// A guest reaches the assistants that work in the areas it holds and nothing else, so the daemon refuses one that is
// unfenced or fenced where nobody works — which means picking the tier can't itself be the write.
const switches = (): HTMLInputElement[] => [...document.body.querySelectorAll<HTMLInputElement>(`input[role=switch]`)];

it(`holds a member's move to guest until its fence reaches an assistant, then grants tier and fence together`, async () => {
    const member = (tier: string): unknown => ({ email: `guest@example.com`, role: tier, status: `accepted`, invitedAt: `2026-08-18T00:00:00.000Z` });
    list.mockResolvedValue({ members: [member(`collaborator`)] });
    setRole.mockResolvedValue({ members: [member(`guest`)] });
    sandboxJson.mockImplementation(async (path: unknown) => (path === `/members` ? { members: daemonMembers() } : { members: [] }));
    mount();
    await settle();

    await pick(`Role for guest@example.com`, `Guest`);
    // Nothing granted yet: the row opens the fence it would need, and says why it is still a collaborator.
    expect(sandboxJson).not.toHaveBeenCalledWith(`/members`, expect.objectContaining({ method: `POST` }));
    expect(setRole).not.toHaveBeenCalled();
    expect(shown()).toContain(`Which areas of the workspace they see`);
    expect(shown()).toContain(`A guest talks to the assistants that work there`);

    daemonMembers.mockReturnValue([{ email: `guest@example.com`, role: `guest`, areas: [`support`] }]);
    switches()[0]?.click();
    await settle();

    const grant = (sandboxJson.mock.calls as unknown[][]).find(
        ([path, init]) => path === `/members` && (init as { method?: string } | undefined)?.method === `POST`,
    );
    if (grant === undefined) {
        throw new Error(`no guest grant reached the sandbox`);
    }
    expect(JSON.parse((grant[1] as { body: string }).body)).toEqual({ email: `guest@example.com`, role: `guest`, areas: [`support`] });
    expect(setRole).toHaveBeenCalledWith({ sandboxId: `s1`, email: `guest@example.com`, role: `guest` });
    // The row now says who they talk to, which for this tier is the whole of what they can do.
    expect(shown()).toContain(`Talks to Support`);
});

// The refusal the owner cannot read off the fence itself: an area can name real folders and still hand over nobody.
it(`will not grant a guest fenced where no assistant works, and says what would fix it`, async () => {
    const member = (tier: string): unknown => ({ email: `guest@example.com`, role: tier, status: `accepted`, invitedAt: `2026-08-18T00:00:00.000Z` });
    list.mockResolvedValue({ members: [member(`collaborator`)] });
    sandboxJson.mockImplementation(async (path: unknown) => (path === `/members` ? { members: daemonMembers() } : { members: [] }));
    mount();
    await settle();

    await pick(`Role for guest@example.com`, `Guest`);
    // Finance names folders of its own, and no assistant starts in any of them.
    switches()[1]?.click();
    await settle();

    expect(sandboxJson).not.toHaveBeenCalledWith(`/members`, expect.objectContaining({ method: `POST` }));
    expect(setRole).not.toHaveBeenCalled();
    expect(shown()).toContain(`No assistant works in these folders`);
    expect(shown()).toContain(`give an assistant a starting folder in one of these areas`);
});

// Fencing somebody is a re-grade at the same tier, so it travels the same two writes in the same order. The
// absence of the field is the whole workspace, which is why an unfenced row sends no field rather than an empty list.
it(`grants an area on an existing row, at the tier that row already holds`, async () => {
    const member = (tier: string): unknown => ({ email: `guest@example.com`, role: tier, status: `accepted`, invitedAt: `2026-08-18T00:00:00.000Z` });
    list.mockResolvedValue({ members: [member(`collaborator`)] });
    setRole.mockResolvedValue({ members: [member(`collaborator`)] });
    sandboxJson.mockImplementation(async (path: unknown) => (path === `/members` ? { members: daemonMembers() } : { members: [] }));
    mount();
    await settle();

    // Drawn on demand, not under every row: what a row holds is already on it as badges, and a picker under each
    // of them would be most of the page. The switches already drawn are the invite form's own, one per area.
    expect(switches()).toHaveLength(2);
    buttonLabelled(`Areas`)?.click();
    await nextTick();
    // The row's own picker, the same one area per switch; the row's come first in the document.
    expect(switches()).toHaveLength(4);
    expect(shown()).toContain(`No area picked: they see the whole workspace, and can talk to every assistant in it.`);
    daemonMembers.mockReturnValue([{ email: `guest@example.com`, role: `collaborator`, areas: [`support`] }]);
    switches()[0]?.click();
    await settle();

    const grant = (sandboxJson.mock.calls as unknown[][]).find(
        ([path, init]) => path === `/members` && (init as { method?: string } | undefined)?.method === `POST`,
    );
    if (grant === undefined) {
        throw new Error(`no fenced grant reached the sandbox`);
    }
    expect(JSON.parse((grant[1] as { body: string }).body)).toEqual({ email: `guest@example.com`, role: `collaborator`, areas: [`support`] });
    // The row now names what it holds, so the fence is readable without opening the picker.
    expect(shown()).toContain(`Support guest`);
});

it(`keeps the token surfaces off a member's tab`, async () => {
    role.value = `viewer`;
    mount();
    await nextTick();
    expect(shown()).not.toContain(`API tokens`);
    expect(shown()).not.toContain(`Other ways in`);
});
