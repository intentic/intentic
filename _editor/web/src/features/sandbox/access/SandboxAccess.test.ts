// Access tab's rendered text after an invite: which of its two writes (daemon grant, platform record/email) failed, and
// refusal vs silence, must all read differently on screen. The page is parts drawn as tabs (People, Profiles, Areas,
// Sign-in, Programs, Allowed); a test about one opens it as a reader would, by its tab.
import { SANDBOX_ROUTE_NAMES } from "@intentic/sandbox-contract";
import "@intentic/testing/dom";
import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import type { OwnerGrant, OwnerGrantKind, StandingGrants } from "@intentic/sandbox-contract/schemas/needs";
import { type OrgPolicyState, OrgPolicyStateSchema, type OrgSectionMode } from "@intentic/sandbox-contract/schemas/organisation";
import { VueQueryPlugin } from "@tanstack/vue-query";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { waitFor } from "@intentic/testing/bun";
import { IconStub } from "@intentic/ui/testing";
import { formatDate } from "@intentic/ui/format";
import type { SandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

type StandingConversation = StandingGrants["conversations"][number];

// Import chain touches the API client and a media query (UI barrel's useDevice) at module eval; hence jsdom.

// What the daemon answers a read nobody in the test cares about: the empty version of each answer the tab parses with the
// route's own schema, so an unanswered read is a quiet section and not a refusal of its shape.
const quiet = (path: unknown) => {
    switch (path) {
        case `/system/passkeys`:
            return { passkeys: [], required: false };
        case `/system/control/tokens`:
            return { tokens: [] };
        case `/system/sessions/revoke`:
            return { ok: true };
        case `/system/runners`:
            return { runners: [] };
        case `/system/links`:
            return { links: [] };
        default:
            return { members: [] };
    }
};
const sandboxJson = jest.fn(async (...args: unknown[]): Promise<unknown> => quiet(args[0]));
jest.mock(`../../../client/sandbox/sandboxClient`, () => ({ sandboxJson: (...args: unknown[]) => sandboxJson(...(args as [])) }));
// The door inventory's reads (automations, workflows, CI, devices) fail unless a test answers them, so a door counts as
// unknown by default; runners ride sandboxJson, whose default answer does not parse as a runner list.
const unread = async (): Promise<never> => {
    throw new Error(`not answered in this test`);
};
type Answer<G extends keyof SandboxRpc, P extends keyof SandboxRpc[G]> = SandboxRpc[G][P] extends (...args: never[]) => Promise<infer A> ? A : never;
const profileList = ref([{ id: `engineering`, label: `Engineering`, brief: `Build with the team`, origin: `sandbox` as const, agents: `run` as const }]);
const serviceList = ref([{ id: `nightly`, label: `Nightly review`, steward: `owner@example.com`, profile: `engineering` }]);
const saveProfile = jest.fn(async (_profile: unknown) => ({ ok: true as const, holders: [{ email: `guest@example.com`, role: `collaborator` as const }] }));
const saveService = jest.fn(async (_service: unknown) => ({ ok: true as const }));
const removeService = jest.fn(async (_id: unknown) => {
    throw new Error(`Used by nightly automation`);
});
// Personal unless a test binds it to an organisation that holds Areas, the one part of this page with an org section of its own.
const orgPolicy = ref<OrgPolicyState>({ bound: false });
const held = (mode: OrgSectionMode): OrgPolicyState =>
    OrgPolicyStateSchema.parse({
        bound: true,
        receivedAt: `2026-10-26T00:00:00.000Z`,
        policy: { orgId: `acme`, orgName: `Acme`, version: 1, sections: { areas: mode } },
    });
const doorReads = {
    automations: jest.fn(async (): Promise<Answer<`automations`, `list`>> => unread()),
    workflows: jest.fn(async (): Promise<Answer<`workflows`, `list`>> => unread()),
    ci: jest.fn(async (): Promise<Answer<`ci`, `runs`>> => unread()),
    devices: jest.fn(async (): Promise<Answer<`system`, `devices`>> => unread()),
};
// What the person dialog's reach lists: a connection a reach can hold back, one it cannot (Docker has no credential), and
// one value the owner keeps. No extension contributes a tile, so a connection is named by itself.
const connected = {
    capabilities: jest.fn(
        async (): Promise<Answer<`capabilities`, `list`>> => ({
            capabilities: [
                { id: `github`, kind: `cli`, status: { state: `active` }, config: { provider: `github` }, secrets: [`token`] },
                { id: `docker`, kind: `docker`, status: { state: `active` }, config: {}, secrets: [] },
            ],
            recommendations: [],
        }),
    ),
    inventory: jest.fn(async () => ({
        entries: [{ key: `DATABASE_URL`, kind: `env` as const, status: `set` as const, requiredBy: [], storedAt: `the sandbox`, revealable: true }],
    })),
};
jest.mock(`../../../client/sandbox/sandboxRpc`, () => ({
    sandboxRpc: fakeSandboxRpc({
        accessProfiles: { list: async () => ({ profiles: profileList.value }), save: (profile: unknown) => saveProfile(profile) },
        services: {
            list: async () => ({ services: serviceList.value }),
            save: (service: unknown) => saveService(service),
            remove: (id: unknown) => removeService(id),
        },
        automations: { list: () => doorReads.automations() },
        workflows: { list: () => doorReads.workflows() },
        ci: { runs: () => doorReads.ci() },
        system: { devices: () => doorReads.devices() },
        capabilities: { list: () => connected.capabilities() },
        secrets: { inventory: () => connected.inventory() },
        extensions: { list: async () => ({ extensions: [], invalid: [], pending: [] }) },
        org: { policy: async () => orgPolicy.value },
        // Sign-in's Previews group reads who may open the previews; open to anyone, which no test here is about.
        ports: { previewGuard: async () => ({ scope: `off` as const }) },
    }),
}));

const create = jest.fn();
const list = jest.fn(async (): Promise<{ members: unknown[] }> => ({ members: [] }));
const setRole = jest.fn();
jest.mock(`../../../lib/useApi`, () => ({
    apiClient: { invite: { list: () => list(), create: (...a: unknown[]) => create(...a), setRole: (...a: unknown[]) => setRole(...a) } },
}));

jest.mock(`../../../client/auth/useAuth`, () => ({ useAuth: () => ({ user: ref({ email: `owner@example.com` }) }) }));
const role = ref<MemberRole>(`owner`);
jest.mock(`../../../client/sandbox/useSandbox`, () => ({
    useSandbox: () => ({
        active: computed(() => ({ name: `radarsu-mig`, role: role.value })),
        activeSandboxId: ref(`s1`),
        daemonUrl: ref(`https://sandbox-abc.example.test`),
        // The sandbox answers: the roster and the door counts are cache reads, asked only of a sandbox that does.
        reachable: ref(true),
    }),
}));
// One assistant, homed in the support folder: which areas hand it over is read off where it starts, never picked.
const personas = ref([{ id: `support`, label: `Support`, capabilities: [], workspace: { startIn: `support` } }]);
jest.mock(`../../../models/sandbox/personas/usePersonas`, () => ({ usePersonas: () => ({ personas, connected: ref([]), isConnected: () => false }) }));
// Two named parts of the workspace: one the assistant above works in, one nobody works in — the two answers a fence
// can give.
const areas = ref([
    { id: `support`, label: `Support guest`, folders: [`support`] },
    { id: `finance`, label: `Finance`, folders: [`finance`] },
]);
const idle = { mutateAsync: async () => ({ ok: true }), isPending: ref(false) };
jest.mock(`../areas/useAreas`, () => ({
    useAreas: () => ({
        areas,
        labelOf: (id: string) => areas.value.find((area) => area.id === id)?.label ?? id,
        loaded: computed(() => ({ state: `ready`, data: areas.value, refreshing: false, refreshError: undefined })),
        save: idle,
        remove: idle,
    }),
}));
jest.mock(`../../../workbench/presence/usePresence`, () => ({ presenceOthers: [], presenceActivity: () => `` }));
// Session module touches GIS/localStorage at eval; needs only its expiry. Fixed date avoids timezone drift.
const sessionExpiresAt = ref<number | undefined>(Date.parse(`2026-09-24T12:00:00.000Z`));
jest.mock(`../../../client/session/sandboxSession`, () => ({ useSandboxSession: () => ({ sessionExpiresAt }) }));
// What conversations were allowed past their persona: none unless a test lists one. Its take-back is a vue-query
// mutation, and this page mounts without a query client.
const standing = ref<readonly StandingConversation[]>([]);
// Beside them the yeses that name no conversation, and the kinds of those this sandbox could not read.
const ownerWide = ref<readonly OwnerGrant[]>([]);
const unreadable = ref<readonly OwnerGrantKind[]>([]);
const takeBackGrant = jest.fn(async (..._args: unknown[]): Promise<void> => undefined);
jest.mock(`./useStandingGrants`, () => ({
    useStandingGrants: () => ({ conversations: standing, ownerWide, unreadable, error: ref(undefined), revoke: { mutateAsync: (...args: unknown[]) => takeBackGrant(...args) } }),
}));

// The AI notice reads the sandbox's settings, which no test here is about.
const quietGroup = { default: { render: () => null } };
jest.mock(`../ai-literacy/AiLiteracySettings.vue`, () => quietGroup);

const { default: SandboxAccess } = await import("./SandboxAccess.vue");
const { setDaemonRoutes } = await import("../../../client/sandbox/useDaemonRoutes");
const { forgetOperations } = await import("../../../workbench/operations/operations");
const { queryClient } = await import("../../../lib/queryPersistence");
const { providerAccounts } = await import("../../../models/providers/providerAccounts");
// A read that fails is shown at once rather than after the retries a browser would give it.
queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });

let app: App | undefined;
let router: Router | undefined;
const mount = (): void => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxAccess) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.use(VueQueryPlugin, { queryClient });
    // The area picker links to the pages that fix what it reports (Areas, Personas); any path resolves.
    router = createRouter({ history: createMemoryHistory(), routes: [{ path: `/:rest(.*)*`, component: { render: () => null } }] });
    app.use(router);
    app.mount(el);
};
// Mounted on an address of its own, as a link from somewhere else opens the page.
const mountAt = async (address: string): Promise<void> => {
    mount();
    await router?.push(address);
    await settle();
};

const shown = (): string => document.body.textContent ?? ``;

const buttonLabelled = (label: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label);

// The People group's own add row: an address, and the Add press that sends it.
const addPerson = async (address: string): Promise<void> => {
    // The last card of the group, drawn once the roster has landed: pressed, it becomes the address field in place.
    await settle();
    [...document.body.querySelectorAll(`button`)].find((button) => button.textContent?.trim().startsWith(`Add person`))?.click();
    await settle();
    const field = document.body.querySelector<HTMLInputElement>(`input[type=email]`);
    if (field === null) {
        throw new Error(`no address field in the add row`);
    }
    field.value = address;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
    field.closest(`form`)?.dispatchEvent(new Event(`submit`));
    await settle();
};

// A person's tile, pressed: their panel opens under the tiles.
const openPerson = async (address: string): Promise<void> => {
    [...document.body.querySelectorAll<HTMLButtonElement>(`[role=group] button`)].find((tile) => tile.textContent?.includes(address))?.click();
    await settle();
};
const panel = (): HTMLElement | null => document.body.querySelector(`section[aria-label]`);
// One part of the open panel, by the label over it.
// A part of the panel by its header: a kit <Section> (its <section>, header first) or a block a view drew itself.
const part = (label: string): HTMLElement | undefined =>
    [...(panel()?.querySelectorAll<HTMLElement>(`section, div`) ?? [])].find((block) => block.firstElementChild?.textContent?.trim() === label);
// The page's own tabs, by name (a count on one rides after its name), and one pressed: its part replaces the one open.
const pageTabs = (): string[] =>
    [...document.body.querySelectorAll<HTMLButtonElement>(`[role=tablist][aria-label="Part of Access"] [role=tab]`)].map((button) =>
        (button.textContent ?? ``).replace(/\d+$/u, ``).trim(),
    );
const openPart = async (label: string): Promise<void> => {
    [...document.body.querySelectorAll<HTMLButtonElement>(`[role=tablist][aria-label="Part of Access"] [role=tab]`)]
        .find((button) => button.textContent?.trim().startsWith(label))
        ?.click();
    await settle();
};
const tab = async (label: string, within?: HTMLElement): Promise<void> => {
    [...(within ?? document.body).querySelectorAll<HTMLButtonElement>(`[role=tab]`)].find((button) => button.textContent?.trim() === label)?.click();
    await nextTick();
};
// What a choice says of itself on hover: its accessible name folds the hover card in, since a phone never sees it.
const hintOf = (label: string, within?: HTMLElement): string | null | undefined =>
    [...(within ?? document.body).querySelectorAll<HTMLButtonElement>(`[role=tab]`)].find((button) => button.textContent?.trim() === label)?.getAttribute(`aria-label`);
const tickRow = async (name: string, within?: HTMLElement): Promise<void> => {
    [...(within ?? panel() ?? document.body).querySelectorAll<HTMLLabelElement>(`label`)]
        .find((row) => row.textContent?.includes(name))
        ?.querySelector<HTMLInputElement>(`input[type=checkbox]`)
        ?.click();
    await nextTick();
};
// The panel saves a moment after the last change, so a run of clicks is one write.
const autosaved = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await settle();
};


// Both rosters land on their own promise, so a row exists a few ticks after mount, not on the next one; a write runs
// through the operations ledger, which lands its answer a task later.
const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 5; tick += 1) {
        await nextTick();
    }
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
};

// The daemon roster's every read, and the grant a guest write answers with.
const daemonMembers = jest.fn((): unknown[] => []);

afterEach(() => {
    sandboxJson.mockReset();
    sandboxJson.mockImplementation(async (...args: unknown[]) => quiet(args[0]));
    queryClient.clear();
    for (const read of Object.values(doorReads)) {
        read.mockReset();
        read.mockImplementation(unread);
    }
    role.value = `owner`;
    orgPolicy.value = { bound: false };
    // Nothing advertised reads as every route answered: today's daemon.
    setDaemonRoutes(undefined);
    create.mockReset();
    setRole.mockReset();
    daemonMembers.mockReset();
    daemonMembers.mockReturnValue([]);
    list.mockReset();
    list.mockResolvedValue({ members: [] });
    sessionExpiresAt.value = Date.parse(`2026-09-24T12:00:00.000Z`);
    standing.value = [];
    ownerWide.value = [];
    unreadable.value = [];
    takeBackGrant.mockReset();
    app?.unmount();
    app = undefined;
    forgetOperations();
    document.body.innerHTML = ``;
});

it(`blames the sandbox only when the sandbox is what failed`, async () => {
    sandboxJson.mockRejectedValue(new Error(`Request failed (500).`));
    mount();
    await addPerson(`guest@example.com`);

    expect(shown()).toContain(`Couldn't grant access on the sandbox`);
    expect(create).not.toHaveBeenCalled();
});

it(`does not ask whether the sandbox is online when the platform is what failed`, async () => {
    create.mockRejectedValue(new Error(`Internal server error`));
    mount();
    await addPerson(`guest@example.com`);

    expect(shown()).not.toMatch(/online\?/);
    expect(shown()).toContain(`recording the invite failed`);
});

it(`hands the owner the link when the email did not carry it`, async () => {
    const writeText = jest.fn(async () => undefined);
    Object.defineProperty(globalThis.navigator, `clipboard`, { value: { writeText }, configurable: true });
    create.mockResolvedValue({
        members: [{ email: `guest@example.com`, role: `collaborator`, status: `pending`, invitedAt: `2026-08-18T00:00:00.000Z` }],
        link: `https://localhost:47145/invite/tok`,
        delivery: `local-link`,
    });
    mount();
    await addPerson(`guest@example.com`);

    expect(shown()).toContain(`Invited.`);
    expect(shown()).toContain(`https://localhost:47145/invite/tok`);

    const copy = [...document.body.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Copy link`);
    copy?.click();
    await nextTick();
    expect(writeText).toHaveBeenCalledWith(`https://localhost:47145/invite/tok`);
});

// The link is the invite when mail did not carry it, and it can be read nowhere else: leaving the tab to open a chat
// app and coming back must still find it.
it(`keeps the link to carry across the tab closing and opening again`, async () => {
    create.mockResolvedValue({
        members: [{ email: `guest@example.com`, role: `collaborator`, status: `pending`, invitedAt: `2026-08-18T00:00:00.000Z` }],
        link: `https://localhost:47145/invite/tok`,
        delivery: `local-link`,
    });
    mount();
    await addPerson(`guest@example.com`);
    app?.unmount();
    document.body.innerHTML = ``;

    mount();
    await settle();
    expect(shown()).toContain(`https://localhost:47145/invite/tok`);
});

it(`shows what the mail provider said when it refused`, async () => {
    create.mockResolvedValue({
        members: [],
        link: `https://app.test/invite/tok`,
        delivery: `refused`,
        reason: `Resend rejected the email (429): daily quota reached`,
    });
    mount();
    await addPerson(`guest@example.com`);

    expect(shown()).toContain(`The email was refused`);
    expect(shown()).toContain(`daily quota reached`);
    expect(shown()).toContain(`https://app.test/invite/tok`);
});

it(`names this browser and nothing it cannot list`, async () => {
    mount();
    await openPart(`Sign-in`);

    expect(shown()).toContain(`This browser`);
    // The date is formatted through the kit, in the READER's zone, so a fixture at 12:00Z prints as the 24th in
    // Europe and the 25th at UTC+14. Asserted through the same formatter the row uses rather than spelled out: a
    // hardcoded day here tests where the suite runs, not what the row says.
    expect(shown()).toContain(`owner@example.com · signed in until ${formatDate(sessionExpiresAt.value as number)}`);
    expect(shown()).not.toContain(`Other browsers`);
});

// undefined pass expiry means a daemon predating the session exchange, not merely absent.
it(`says only that this browser is signed in when there is no pass to date`, async () => {
    sessionExpiresAt.value = undefined;
    mount();
    await openPart(`Sign-in`);

    expect(shown()).toContain(`owner@example.com · signed in`);
    expect(shown()).not.toMatch(/signed in until/);
});

it(`arms sign-out-everywhere before firing it, and says who it hits`, async () => {
    mount();
    await openPart(`Sign-in`);

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
    await openPart(`Sign-in`);

    buttonLabelled(`Sign out all browsers`)?.click();
    await nextTick();
    // Two buttons share this label once armed; the confirm's is last.
    const confirm = [...document.body.querySelectorAll(`button`)].findLast((button) => button.textContent?.trim() === `Sign out all browsers`);
    confirm?.click();
    await settle();

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
        return quiet(path);
    });
    mount();
    await openPart(`Programs`);
    await waitFor(() => expect(shown()).toContain(`nightly CI`));
    expect(shown()).toContain(`API tokens`);
    expect(shown()).toContain(`never used`);
    // The form is asked for, not standing open over the list.
    expect(buttonLabelled(`Mint token`)).toBeUndefined();

    buttonLabelled(`New token`)?.click();
    await nextTick();
    buttonLabelled(`Mint token`)?.click();
    await waitFor(() => expect(shown()).toContain(`ict_shown-once`));
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
    // Minted, the form gives way to the value it made, and New token is offered again.
    expect(buttonLabelled(`Mint token`)).toBeUndefined();
    expect(buttonLabelled(`New token`)?.disabled).toBe(false);
});

it(`says what a token is for when there is none, rather than drawing an empty card`, async () => {
    mount();
    await openPart(`Programs`);
    await waitFor(() => expect(shown()).toContain(`No API tokens.`));
    buttonLabelled(`New token`)?.click();
    await nextTick();
    expect(shown()).not.toContain(`No API tokens.`);
    buttonLabelled(`Cancel`)?.click();
    await nextTick();
    expect(buttonLabelled(`Mint token`)).toBeUndefined();
});

// The daemon's POST /members bodies, in order.
const grantsSent = (): unknown[] =>
    // SAFETY: sandboxJson is called as (path, init) by sandboxRaw, and a POST's init carries its JSON body as a string.
    (sandboxJson.mock.calls as unknown[][])
        .filter(([path, init]) => path === `/members` && (init as { method?: string } | undefined)?.method === `POST`)
        .map(([, init]) => JSON.parse((init as { body: string }).body) as unknown);

const accepted = (tier: string) => ({ email: `guest@example.com`, role: tier, status: `accepted`, invitedAt: `2026-08-18T00:00:00.000Z` });
// A member the platform and the daemon both know, the daemon answering whatever `daemonMembers` holds.
const withMember = (tier: string, row: Record<string, unknown> = {}): void => {
    list.mockResolvedValue({ members: [accepted(tier)] });
    daemonMembers.mockReturnValue([{ email: `guest@example.com`, role: tier, ...row }]);
    sandboxJson.mockImplementation(async (path: unknown) => (path === `/members` ? { members: daemonMembers() } : quiet(path)));
};

/* ADDING A PERSON: an address alone, and they start able to see and nothing more. */

it(`adds a person read-only with nothing to spend, and opens them`, async () => {
    create.mockResolvedValue({
        members: [{ email: `dee@corp.example`, role: `viewer`, status: `pending`, invitedAt: `2026-08-18T00:00:00.000Z` }],
        link: `https://localhost:47145/invite/tok`,
        delivery: `sent`,
    });
    mount();
    await settle();
    await addPerson(`dee@corp.example`);

    expect(grantsSent()).toEqual([
        { email: `dee@corp.example`, role: `viewer`, emailSignIn: true, agents: `off`, credentials: { capabilities: [], secrets: [] }, aiAccounts: `all` },
    ]);
    expect(create).toHaveBeenCalledWith({ sandboxId: `s1`, email: `dee@corp.example`, role: `viewer` });
    // Their tile says what they can do, and their panel is open for the rest.
    expect(shown()).toContain(`Can see`);
    expect(panel()?.textContent).toContain(`Invite pending`);
});

/* THE PANEL: each change saves a moment after it is made, as one grant; an answer the daemon would refuse waits, said. */

// A person who only chats reaches the assistants in their areas and nothing else, so the daemon refuses one with no area
// or one whose areas nobody works in; the panel holds it until it is one the daemon takes, then sends it whole.
it(`holds a move to chatting until its areas reach an assistant, then saves it`, async () => {
    withMember(`collaborator`);
    setRole.mockResolvedValue({ members: [accepted(`guest`)] });
    mount();
    await settle();
    await openPerson(`guest@example.com`);
    await tab(`Chat with assistants`);
    await autosaved();
    expect(shown()).toContain(`Not saved`);
    expect(shown()).toContain(`they talk to the assistants that work there`);
    expect(grantsSent()).toEqual([]);

    await tickRow(`Support guest`);
    expect(shown()).not.toContain(`No assistant works in these areas.`);
    daemonMembers.mockReturnValue([{ email: `guest@example.com`, role: `guest`, agents: `chat`, areas: [`support`] }]);
    await autosaved();

    expect(grantsSent()).toEqual([
        { email: `guest@example.com`, role: `guest`, emailSignIn: false, agents: `chat`, areas: [`support`], credentials: `all`, aiAccounts: `all` },
    ]);
    expect(setRole).toHaveBeenCalledWith({ sandboxId: `s1`, email: `guest@example.com`, role: `guest` });
});

// The refusal the owner cannot read off the fence itself: an area can name real folders and still hand over nobody.
it(`will not save a chat in areas no assistant works in, and says so`, async () => {
    withMember(`collaborator`);
    mount();
    await settle();
    await openPerson(`guest@example.com`);
    await tab(`Chat with assistants`);
    await tickRow(`Finance`);
    await autosaved();

    expect(shown()).toContain(`No assistant works in these areas.`);
    expect(grantsSent()).toEqual([]);
    expect(setRole).not.toHaveBeenCalled();
});

// Seeing and editing are separate answers: someone may read the whole workspace and change files in one area by hand,
// with agents off, which is a writer that drives nothing.
it(`lets a person edit some areas by hand, see everything, and run no agents`, async () => {
    withMember(`collaborator`);
    setRole.mockResolvedValue({ members: [accepted(`writer`)] });
    mount();
    await settle();
    await openPerson(`guest@example.com`);
    await tab(`Off`, part(`Agents`));
    await tab(`Only some areas`, part(`Can edit by hand`));
    await tickRow(`Support guest`, part(`Can edit by hand`));
    await autosaved();

    expect(grantsSent()).toEqual([
        { email: `guest@example.com`, role: `writer`, emailSignIn: false, agents: `off`, edit: [`support`], credentials: `all`, aiAccounts: `all` },
    ]);
    expect(setRole).toHaveBeenCalledWith({ sandboxId: `s1`, email: `guest@example.com`, role: `writer` });
});

// What their agents may spend is in the same panel, sent in the same grant, and enforced by the sandbox. Narrowing
// starts from nothing ticked, lists only what a reach can hold back, and names the rest as always available.
it(`limits what a person's agents may use`, async () => {
    withMember(`collaborator`);
    mount();
    await settle();
    await openPerson(`guest@example.com`);
    await tab(`Only these`, part(`Connections and secrets`));
    await settle();
    expect(shown()).toContain(`0 of 2 picked`);
    expect(hintOf(`Only these`, part(`Connections and secrets`))).toContain(`Always available Docker`);
    await tickRow(`github`);
    await autosaved();

    expect(grantsSent()).toEqual([
        {
            email: `guest@example.com`,
            role: `collaborator`,
            emailSignIn: false,
            agents: `run`,
            credentials: { capabilities: [`github`], secrets: [] },
            aiAccounts: `all`,
        },
    ]);
    expect(setRole).not.toHaveBeenCalled();
});

// Which AI accounts pay for their turns is its own answer beside what their agents work with: narrowing it starts from
// nothing ticked, and the grant names the accounts as the daemon keys them, so a turn on any other is refused there.
it(`limits which AI accounts a person's conversations run on`, async () => {
    providerAccounts.value = {
        ...providerAccounts.value,
        claude: [
            { id: `home`, label: `Home`, connectedAt: 0 },
            { id: `work`, label: `Work`, connectedAt: 1 },
        ],
    };
    try {
        withMember(`collaborator`);
        mount();
        await settle();
        await openPerson(`guest@example.com`);
        const accounts = part(`AI accounts`);
        expect(hintOf(`All`, accounts)).toContain(`Every AI account`);
        await tab(`Only these`, accounts);
        await settle();
        expect(shown()).toContain(`Pick at least one AI account their agents can run on.`);
        await tickRow(`Work`, part(`AI accounts`));
        await autosaved();

        expect(grantsSent()).toEqual([
            { email: `guest@example.com`, role: `collaborator`, emailSignIn: false, agents: `run`, credentials: `all`, aiAccounts: [`claude:work`] },
        ]);
    } finally {
        providerAccounts.value = { ...providerAccounts.value, claude: [] };
    }
});

// Managing is every other answer at once, so it is asked first; the panel then says what it hands over rather than
// drawing controls that would mean nothing. What their conversations spend is still asked beneath it.
it(`gives a person full access with the first choice`, async () => {
    withMember(`viewer`);
    setRole.mockResolvedValue({ members: [accepted(`maintainer`)] });
    mount();
    await settle();
    await openPerson(`guest@example.com`);
    await tab(`Full access`, part(`Access`));
    expect(shown()).toContain(`Publish, change settings and connections`);
    expect(hintOf(`Chat with assistants`)).toBeUndefined();
    expect(hintOf(`All`, part(`AI accounts`))).toContain(`Every AI account`);
    expect(part(`Connections and secrets`)?.textContent).toContain(`Only these`);
    expect(shown()).not.toContain(`which can get around them`);
    await autosaved();

    expect(grantsSent()).toEqual([{ email: `guest@example.com`, role: `maintainer`, emailSignIn: false, credentials: `all`, aiAccounts: `all` }]);
    expect(setRole).toHaveBeenCalledWith({ sandboxId: `s1`, email: `guest@example.com`, role: `maintainer` });
});

// Managing the sandbox and paying for every turn are separate answers: someone may change every setting, add providers
// included, while their own turns run only on the accounts picked for them. The AI accounts picked before carry across.
it(`gives a person full access on only some AI accounts`, async () => {
    providerAccounts.value = {
        ...providerAccounts.value,
        claude: [
            { id: `home`, label: `Home`, connectedAt: 0 },
            { id: `work`, label: `Work`, connectedAt: 1 },
        ],
    };
    try {
        withMember(`collaborator`);
        setRole.mockResolvedValue({ members: [accepted(`maintainer`)] });
        mount();
        await settle();
        await openPerson(`guest@example.com`);
        await tab(`Only these`, part(`AI accounts`));
        await tickRow(`Work`, part(`AI accounts`));
        await tab(`Full access`, part(`Access`));
        expect(shown()).toContain(`which can get around them`);
        await autosaved();

        expect(grantsSent().at(-1)).toEqual({ email: `guest@example.com`, role: `maintainer`, emailSignIn: false, credentials: `all`, aiAccounts: [`claude:work`] });
    } finally {
        providerAccounts.value = { ...providerAccounts.value, claude: [] };
    }
});

// With no assistant homed in any area, nobody can be set to chat; that is said once, before any area is tried.
it(`tells the owner up front when no area has an assistant to chat with`, async () => {
    const homed = personas.value;
    personas.value = [];
    try {
        withMember(`viewer`);
        mount();
        await settle();
        await openPerson(`guest@example.com`);
        await tab(`Chat with assistants`);
        expect(shown()).toContain(`No assistant works in any area yet.`);
    } finally {
        personas.value = homed;
    }
});

// A grant replaces the member's whole row on the daemon, so one sent while that roster is unread would drop what the
// row holds and widen what the person gets; the tab says so and opens nobody to rewrite.
it(`opens nobody while it cannot read what each person may do`, async () => {
    list.mockResolvedValue({ members: [accepted(`collaborator`)] });
    sandboxJson.mockImplementation(async (path: unknown, init?: unknown) => {
        if (path === `/members` && init === undefined) {
            throw new Error(`Request failed (503).`);
        }
        return quiet(path);
    });
    mount();
    await settle();

    expect(shown()).toContain(`guest@example.com`);
    expect(shown()).toContain(`Couldn't read what each person may do, so nobody's access can be changed until the sandbox answers.`);
    await openPerson(`guest@example.com`);
    expect(panel()).toBeNull();
    expect(grantsSent()).toEqual([]);
});

// The tile names a person by what they can do, from the daemon's own row.
it(`names each person by what they can do`, async () => {
    withMember(`writer`, { areas: [`support`], agents: `off`, edit: [`support`] });
    mount();
    await settle();
    expect(shown()).toContain(`Edits`);
});


// Writer is the tier just under the maintainer floor these surfaces share, so it is the one a looser gate would let in.
it(`keeps the token surfaces off the tab of a member below maintainer`, async () => {
    role.value = `writer`;
    mount();
    await settle();
    // Their own card and their own passkeys: Programs and Allowed are not theirs to open.
    expect(pageTabs()).toEqual([`People`, `Sign-in`]);
    await openPart(`Sign-in`);
    expect(shown()).toContain(`Passkeys`);
    expect(shown()).not.toContain(`Signed-in browsers`);
    // Who may open the previews is read by every member, and changed by the owner alone.
    await waitFor(() => expect(shown()).toContain(`Only the sandbox owner can change who can open previews.`));
    // An address naming a part they are not drawn opens their first.
    app?.unmount();
    document.body.innerHTML = ``;
    await mountAt(`/?section=programs`);
    expect(shown()).not.toContain(`API tokens`);
    expect(shown()).toContain(`Only the sandbox owner can invite people or change roles.`);
});

// A maintainer holds the owner's operating authority, so the credential and door surfaces are theirs as well. The
// roster is the one part of this tab that stays the owner's: never read for them, never offered, and said so.
it(`gives a maintainer the token, sign-out and door surfaces, and keeps the roster the owner's`, async () => {
    role.value = `maintainer`;
    mount();
    await settle();

    expect(pageTabs()).toEqual([`People`, `Profiles`, `Areas`, `Sign-in`, `Programs`, `Allowed`]);
    expect(list).not.toHaveBeenCalled();
    expect(document.body.querySelector(`input[type=email]`)).toBeNull();
    expect(shown()).toContain(`Only the sandbox owner can invite people or change roles.`);

    await openPart(`Programs`);
    expect(shown()).toContain(`API tokens`);
    expect(buttonLabelled(`New token`)?.disabled).toBe(false);
    expect(shown()).toContain(`Other ways in`);

    await openPart(`Sign-in`);
    expect(shown()).toContain(`Signed-in browsers`);
    expect(buttonLabelled(`Sign out all browsers`)?.disabled).toBe(false);
});

// Every door read answers "none in use": a zero is a door nobody opened, so the group has nothing to say and is not drawn.
it(`leaves out the other ways in when no door is in use`, async () => {
    doorReads.automations.mockResolvedValue({ automations: [] });
    doorReads.workflows.mockResolvedValue({ workflows: [] });
    doorReads.ci.mockResolvedValue({ repos: [], runs: [] });
    doorReads.devices.mockResolvedValue({ devices: [] });
    sandboxJson.mockImplementation(async (path: unknown) => quiet(path));
    mount();
    await openPart(`Programs`);
    await settle();

    expect(shown()).toContain(`API tokens`);
    expect(shown()).not.toContain(`Other ways in`);
});

// Only the doors in use are rows, and a paired machine is counted rather than described; a door the daemon could not
// read stays, since an unread door is not a closed one.
it(`lists only the doors in use, with paired machines counted`, async () => {
    doorReads.automations.mockResolvedValue({ automations: [] });
    doorReads.ci.mockResolvedValue({ repos: [], runs: [] });
    doorReads.devices.mockResolvedValue({ devices: [{ key: `laptop`, label: `laptop` }, { key: `desk`, label: `desk` }] });
    sandboxJson.mockImplementation(async (path: unknown) => quiet(path));
    mount();
    await openPart(`Programs`);
    await settle();

    expect(shown()).toContain(`Other ways in`);
    expect(shown()).not.toContain(`Webhooks`);
    expect(shown()).not.toContain(`CI notifications`);
    expect(shown()).toContain(`Release gates`);
    expect(shown()).toContain(`2 devices, each holding its own enrollment key.`);
    expect(shown()).not.toContain(`0 runners`);
});

// What a conversation was allowed past its persona is taken back here, where the rest of who-reaches-this-box is: the
// Needs you inbox's Allowed tab until 2026-10-12. Nothing standing draws nothing.
it(`lists what conversations were allowed past their persona, each with Revoke`, async () => {
    mount();
    await openPart(`Allowed`);
    expect(shown()).not.toContain(`Conversation permissions`);
    // Nothing standing is said, not drawn as a blank part.
    expect(shown()).toContain(`Nothing is allowed past the rules`);
    app?.unmount();
    document.body.innerHTML = ``;

    standing.value = [
        { conversationId: `c1`, capabilities: [`github`], folders: [], shelves: [], installs: false, secrets: [], everything: false, rules: [], releases: [] },
    ];
    mount();
    await openPart(`Allowed`);

    expect(shown()).not.toContain(`Nothing is allowed past the rules`);
    expect(shown()).toContain(`Conversation permissions`);
    expect(shown()).toContain(`May use github, which its persona leaves out`);
    expect(buttonLabelled(`Revoke`)?.disabled).toBe(false);
});

// The yeses that name no conversation sit above the conversations, in a group of their own: a policy line allowed with
// Always, an approved hook set, an approved extension. Each is revoked by what names it, the policy line itself, the
// set's digest, the extension's id.
it(`lists the owner-wide yeses above the conversations, and takes each back by its own name`, async () => {
    const digest = `a`.repeat(64);
    ownerWide.value = [
        { kind: `extension`, id: `acme.toolbox`, powers: [`runs a backend bundle inside the daemon's extension host`], at: Date.now() - 60_000 },
        { kind: `command-policy`, line: `Deleting build directories under /work is fine.`, at: Date.now() - 120_000, by: `ada@acme.dev` },
        { kind: `hook-set`, digest, hooks: [`PreToolUse (Bash): ./guard.sh`], at: Date.now() - 180_000 },
    ];
    standing.value = [{ conversationId: `c1`, capabilities: [`github`], folders: [], shelves: [], installs: false, secrets: [], everything: false, rules: [], releases: [] }];
    mount();
    await openPart(`Allowed`);

    expect(shown()).toContain(`Sandbox-wide permissions`);
    expect(shown()).toContain(`Conversation permissions`);
    expect(shown()).toContain(`Safety policy: Deleting build directories under /work is fine.`);
    expect(shown()).toContain(`allowed by ada@acme.dev`);
    expect(shown()).toContain(`Claude Code hooks may run: PreToolUse (Bash): ./guard.sh`);
    expect(shown()).toContain(`Extension acme.toolbox may run`);
    expect(shown()).toContain(`approved to: runs a backend bundle inside the daemon's extension host`);
    // The conversation's own yes is still there, after them.
    expect(shown().indexOf(`May use github, which its persona leaves out`)).toBeGreaterThan(shown().indexOf(`Extension acme.toolbox may run`));

    const revokes = [...document.body.querySelectorAll(`button`)].filter((button) => button.textContent?.trim() === `Revoke`);
    expect(revokes).toHaveLength(4);
    for (const button of revokes.slice(0, 3)) {
        button.click();
        await settle();
    }
    expect(takeBackGrant.mock.calls).toEqual([
        [{ kind: `extension`, what: `acme.toolbox` }],
        [{ kind: `command-policy`, what: `Deleting build directories under /work is fine.` }],
        [{ kind: `hook-set`, what: digest }],
    ]);
});

it(`says which owner-wide records could not be read, and draws the list for them alone`, async () => {
    unreadable.value = [`hook-set`, `extension`];
    mount();
    await openPart(`Allowed`);
    expect(shown()).toContain(`Sandbox-wide permissions`);
    expect(shown()).not.toContain(`Conversation permissions`);
    expect(shown()).toContain(`none of it stands until the file is fixed: hook sets, extensions.`);
});

/* EMAIL SIGN-IN: whether intentic's word for an address opens this sandbox for its person, decided with the invite and
   switched in the panel afterwards. */

// Google already vouches for its own addresses: a second road for one is one the owner did not ask for.
it(`leaves email-code sign-in off for an address Google holds`, async () => {
    create.mockResolvedValue({ members: [], link: `https://localhost:47145/invite/tok`, delivery: `sent` });
    mount();
    await settle();
    const address = [`dee`, `gmail.com`].join(`@`);
    await addPerson(address);

    expect(grantsSent()).toEqual([
        { email: address, role: `viewer`, emailSignIn: false, agents: `off`, credentials: { capabilities: [], secrets: [] }, aiAccounts: `all` },
    ]);
});

// Changing how somebody signs in is one daemon write that carries the rest of their access as it stands (a grant
// replaces the row whole), and nothing for the platform, whose record has no way in to hold.
it(`changes a person's email sign-in with the rest of their access kept, at the sandbox alone`, async () => {
    withMember(`collaborator`, { areas: [`support`] });
    mount();
    await settle();
    await openPerson(`guest@example.com`);
    const toggle = [...(panel()?.querySelectorAll<HTMLInputElement>(`input[role="switch"]`) ?? [])].at(-1);
    expect(toggle?.checked).toBe(false);
    toggle?.click();
    await autosaved();

    expect(grantsSent()).toEqual([
        { email: `guest@example.com`, role: `collaborator`, emailSignIn: true, agents: `run`, areas: [`support`], credentials: `all`, aiAccounts: `all` },
    ]);
    expect(setRole).not.toHaveBeenCalled();
});

/* THE PARTS: People opens first, every other part is a tab and an address, and the links made before the parts had names
   still land where they meant. */

it(`opens on People, and keeps the part it was switched to in the address`, async () => {
    mount();
    await settle();
    expect(pageTabs()).toEqual([`People`, `Profiles`, `Areas`, `Sign-in`, `Programs`, `Allowed`]);
    expect(shown()).toContain(`Add person`);
    expect(shown()).not.toContain(`Passkeys`);

    await openPart(`Sign-in`);
    expect(router?.currentRoute.value.query[`section`]).toBe(`sign-in`);
    expect(shown()).toContain(`Passkeys`);
    expect(shown()).not.toContain(`Add person`);

    // Back on the first part, the address names none.
    await openPart(`People`);
    expect(router?.currentRoute.value.query[`section`]).toBeUndefined();
});

it(`lands on Programs from a waiting linked task's address, old and new`, async () => {
    await mountAt(`/?sandbox=s1#linked-sandboxes`);
    expect(shown()).toContain(`API tokens`);
    app?.unmount();
    document.body.innerHTML = ``;

    await mountAt(`/?section=links`);
    expect(shown()).toContain(`API tokens`);
    app?.unmount();
    document.body.innerHTML = ``;

    await mountAt(`/?section=programs&sandbox=s1#linked-sandboxes`);
    expect(shown()).toContain(`API tokens`);
});

// A task a linked sandbox handed over waits for the owner's Allow on Programs; the count says so from People.
it(`counts the linked tasks waiting for a yes on the Programs tab`, async () => {
    const link = {
        id: `l1`,
        label: `support-desk`,
        terms: { approve: true, turnsPerHour: 20 },
        createdAt: Date.parse(`2026-09-01T00:00:00Z`),
        conversations: 0,
        requests: [{ id: `r1`, conversationId: `c9`, task: `Draft the refund macro`, askedAt: Date.now() - 60_000 }],
    };
    sandboxJson.mockImplementation(async (path: unknown) => (path === `/system/links` ? { links: [link] } : quiet(path)));
    mount();
    await waitFor(() =>
        expect([...document.body.querySelectorAll(`[role=tab]`)].find((button) => button.textContent?.trim().startsWith(`Programs`))?.textContent?.trim()).toBe(
            `Programs1`,
        ),
    );
});

it(`counts what stands on the Allowed tab, so it is seen from any part`, async () => {
    ownerWide.value = [{ kind: `command-policy`, line: `Deleting build directories under /work is fine.`, at: Date.now() - 120_000, by: `ada@acme.dev` }];
    standing.value = [{ conversationId: `c1`, capabilities: [`github`], folders: [], shelves: [], installs: false, secrets: [], everything: false, rules: [], releases: [] }];
    mount();
    await settle();
    const allowed = [...document.body.querySelectorAll(`[role=tab]`)].find((button) => button.textContent?.trim().startsWith(`Allowed`));
    expect(allowed?.textContent?.trim()).toBe(`Allowed2`);
});


// Areas was a hub row until 2026-10-26, and an organisation still holds it as a section of its own: hidden, it leaves the
// tabs; locked, it reads under the organisation's notice. A sandbox's old address for it lands on the part.
it(`draws Areas as a part, and lets an organisation hide or lock it`, async () => {
    mount();
    await openPart(`Areas`);
    expect(router?.currentRoute.value.query[`section`]).toBe(`areas`);
    await waitFor(() => expect(shown()).toContain(`Finance`));
    expect(shown()).toContain(`New area`);
    expect(shown()).not.toContain(`manages this part`);
    app?.unmount();
    document.body.innerHTML = ``;

    // The policy is a cached read; a fresh mount reads it again only once the cache is gone.
    queryClient.clear();
    orgPolicy.value = held(`locked`);
    await mountAt(`/?section=areas`);
    await waitFor(() => expect(shown()).toContain(`Acme manages this part`));
    expect(shown()).toContain(`Finance`);
    app?.unmount();
    document.body.innerHTML = ``;

    queryClient.clear();
    orgPolicy.value = held(`hidden`);
    mount();
    await waitFor(() => expect(pageTabs()).toEqual([`People`, `Profiles`, `Sign-in`, `Programs`, `Allowed`]));
});

it(`hides profiles and services on older daemons`, async () => {
    // A daemon from before access profiles advertises every route but theirs.
    setDaemonRoutes(SANDBOX_ROUTE_NAMES.filter((name) => !name.startsWith(`accessProfiles.`) && !name.startsWith(`services.`)));
    mount();
    await settle();
    expect(pageTabs()).toEqual([`People`, `Areas`, `Sign-in`, `Programs`, `Allowed`]);
    await openPart(`Programs`);
    expect(shown()).not.toContain(`New service`);
    expect(shown()).not.toContain(`Runs as`);
});

// A profile and a service are named, never given an id or a purpose: a new one's id is folded from its name, a name
// already in the list is held back with the reason, and renaming one keeps the id every holder points at.
const fill = async (field: HTMLInputElement, value: string): Promise<void> => {
    field.value = value;
    field.dispatchEvent(new Event(`input`));
    await settle();
};
const formFields = (): HTMLInputElement[] => [...document.body.querySelectorAll<HTMLInputElement>(`form input:not([type=checkbox]):not([role=switch])`)];

it(`names a new profile, and derives its id from that name`, async () => {
    saveProfile.mockClear();
    mount();
    await openPart(`Profiles`);
    await waitFor(() => expect(shown()).toContain(`Engineering`));
    buttonLabelled(`New profile`)?.click();
    await settle();
    expect(shown()).not.toContain(`Purpose`);
    const [name] = formFields();
    expect(name?.placeholder).toBe(`e.g. Interns`);

    await fill(name!, `engineering`);
    expect(shown()).toContain(`A profile named engineering already exists.`);
    expect(buttonLabelled(`Save`)?.disabled).toBe(true);

    await fill(name!, `Księgowość`);
    buttonLabelled(`Save`)?.click();
    await waitFor(() => expect(saveProfile).toHaveBeenCalledWith(expect.objectContaining({ id: `ksiegowosc`, label: `Księgowość` })));
});

it(`keeps a profile's id when it is renamed, and drops the purpose it carried`, async () => {
    saveProfile.mockClear();
    mount();
    await openPart(`Profiles`);
    await waitFor(() => expect(shown()).toContain(`Engineering`));
    expect(shown()).not.toContain(`Build with the team`);
    buttonLabelled(`Edit`)?.click();
    await settle();
    await fill(formFields()[0]!, `Platform team`);
    buttonLabelled(`Save`)?.click();
    await waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1));
    expect(saveProfile.mock.calls[0]?.[0]).toMatchObject({ id: `engineering`, label: `Platform team` });
    expect(saveProfile.mock.calls[0]?.[0]).not.toHaveProperty(`brief`);
});

it(`names a new service, and derives the id automations run as from that name`, async () => {
    saveService.mockClear();
    // A service acts for a steward, the owner unless one is picked, so the roster names one.
    sandboxJson.mockImplementation(async (path: unknown) => {
        const answer = quiet(path);
        return `members` in answer ? { ...answer, owner: `owner@example.com` } : answer;
    });
    mount();
    await openPart(`Programs`);
    await waitFor(() => expect(shown()).toContain(`Nightly review`));
    buttonLabelled(`New service`)?.click();
    await settle();
    const [name] = formFields();
    await fill(name!, `Nightly review`);
    expect(shown()).toContain(`A service named Nightly review already exists.`);
    await fill(name!, `Marketing bot`);
    buttonLabelled(`Save`)?.click();
    await waitFor(() => expect(saveService).toHaveBeenCalledWith(expect.objectContaining({ id: `marketing-bot`, label: `Marketing bot` })));
});

it(`shows profiles, their tier and service holders, then synchronizes changed holder tiers`, async () => {
    list.mockResolvedValue({ members: [{ email: `guest@example.com`, role: `viewer` }] });
    setRole.mockResolvedValue({ members: [] });
    mount();
    await openPart(`Profiles`);
    await waitFor(() => expect(shown()).toContain(`Engineering`));
    expect(shown()).toContain(`Nightly review`);
    expect(shown()).toContain(`Collaborator`);
    buttonLabelled(`Edit`)?.click();
    await settle();
    buttonLabelled(`Save`)?.click();
    await waitFor(() => expect(saveProfile).toHaveBeenCalledWith(expect.objectContaining({ id: `engineering`, label: `Engineering` })));
    await waitFor(() => expect(setRole).toHaveBeenCalledWith({ sandboxId: `s1`, email: `guest@example.com`, role: `collaborator` }));
});

it(`shows a service deletion refusal with the named dependency`, async () => {
    mount();
    await openPart(`Programs`);
    await waitFor(() => expect(shown()).toContain(`Nightly review`));
    buttonLabelled(`Delete`)?.click();
    await waitFor(() => expect(shown()).toContain(`Used by nightly automation`));
});


it(`grants a named profile with its tier and hides editable inline answers`, async () => {
    // The profile picker's overlay measures its anchor and closes on one of no size, which is every element jsdom lays
    // out (pick/MultiPick.test.ts does the same); with sizes, a skeleton imprint then reads text lines, which jsdom's
    // Range lacks (design-system/await.test.ts stubs it the same way).
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function rect(): DOMRect {
        return { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 32, width: 320, height: 32, toJSON: () => ({}) };
    };
    Range.prototype.getClientRects = (): DOMRectList => Object.assign([], { item: () => null });
    try {
        withMember(`viewer`);
        mount();
        await settle();
        await openPerson(`guest@example.com`);
        await waitFor(() => expect(document.querySelector(`button[aria-label="Profiles"]`)).not.toBeNull());
        document.querySelector<HTMLButtonElement>(`button[aria-label="Profiles"]`)?.click();
        await settle();
        [...document.querySelectorAll<HTMLElement>(`[role=option]`)].find((option) => option.textContent?.includes(`Engineering`))?.click();
        await autosaved();
        expect(grantsSent()).toEqual([{ email: `guest@example.com`, role: `collaborator`, profile: `engineering`, emailSignIn: false }]);
        expect(panel()?.querySelector(`fieldset`)?.disabled).toBe(true);
    } finally {
        HTMLElement.prototype.getBoundingClientRect = realRect;
        Reflect.deleteProperty(Range.prototype, `getClientRects`);
    }
});

it(`does not re-grade a profile holder whose platform tier already agrees`, async () => {
    list.mockResolvedValue({ members: [{ email: `guest@example.com`, role: `collaborator` }] });
    mount();
    await openPart(`Profiles`);
    await waitFor(() => expect(shown()).toContain(`Engineering`));
    buttonLabelled(`Edit`)?.click();
    await settle();
    buttonLabelled(`Save`)?.click();
    await waitFor(() => expect(document.querySelector(`main form`)).toBeNull());
    expect(setRole).not.toHaveBeenCalled();
});
