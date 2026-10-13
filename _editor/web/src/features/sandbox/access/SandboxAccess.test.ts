// Access tab's rendered text after an invite: which of its two writes (daemon grant, platform record/email) failed, and
// refusal vs silence, must all read differently on screen.
import "@intentic/testing/dom";
import type { MemberRole, OwnerGrant, OwnerGrantKind, StandingGrants } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
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
        automations: { list: () => doorReads.automations() },
        workflows: { list: () => doorReads.workflows() },
        ci: { runs: () => doorReads.ci() },
        system: { devices: () => doorReads.devices() },
        capabilities: { list: () => connected.capabilities() },
        secrets: { inventory: () => connected.inventory() },
        extensions: { list: async () => ({ extensions: [], invalid: [], pending: [] }) },
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
jest.mock(`../overview/useSandboxOutline`, () => ({ useSandboxOutline: () => false }));
// One assistant, homed in the support folder: which areas hand it over is read off where it starts, never picked.
const personas = ref([{ id: `support`, label: `Support`, capabilities: [], workspace: { startIn: `support` } }]);
jest.mock(`../personas/usePersonas`, () => ({ usePersonas: () => ({ personas, connected: ref([]), isConnected: () => false }) }));
// Two named parts of the workspace: one the assistant above works in, one nobody works in — the two answers a fence
// can give.
const areas = ref([
    { id: `support`, label: `Support guest`, folders: [`support`] },
    { id: `finance`, label: `Finance`, folders: [`finance`] },
]);
jest.mock(`../areas/useAreas`, () => ({
    useAreas: () => ({ areas, labelOf: (id: string) => areas.value.find((area) => area.id === id)?.label ?? id }),
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

const { default: SandboxAccess } = await import("./SandboxAccess.vue");
const { forgetOperations } = await import("../../../workbench/operations/operations");
const { queryClient } = await import("../../../lib/queryPersistence");
// A read that fails is shown at once rather than after the retries a browser would give it.
queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });

let app: App | undefined;
const mount = (): void => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxAccess) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    // The area picker links to the pages that fix what it reports (Areas, Personas); any path resolves.
    app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: `/:rest(.*)*`, component: { render: () => null } }] }));
    app.mount(el);
};

const shown = (): string => document.body.textContent ?? ``;

const buttonLabelled = (label: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label);

const dialog = (): HTMLElement | null => document.body.querySelector(`[role=dialog]`);

// The person dialog, opened for a new address and filled in; nothing is sent until its commit press.
const openInvite = async (address: string): Promise<void> => {
    buttonLabelled(`Add person`)?.click();
    await settle();
    const field = document.body.querySelector<HTMLInputElement>(`input[type=email]`);
    if (field === null) {
        throw new Error(`no address field in the person dialog`);
    }
    field.value = address;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
};

// Sends whatever the dialog holds: an invite, or an edit's whole grant.
const commit = async (): Promise<void> => {
    dialog()?.querySelector(`form`)?.dispatchEvent(new Event(`submit`));
    await settle();
};

const inviteEmail = async (address: string): Promise<void> => {
    await openInvite(address);
    await commit();
};

// The dialog opened on somebody already here.
const openEdit = async (address: string): Promise<void> => {
    document.body.querySelector<HTMLButtonElement>(`button[aria-label="Edit access for ${address}"]`)?.click();
    await settle();
};

// A tier in the dialog's role list, an area or a reach row ticked by its name, and one of a pair of scope tabs.
const pickRole = async (label: string): Promise<void> => {
    [...document.body.querySelectorAll<HTMLButtonElement>(`[role=radio]`)].find((row) => row.textContent?.trim().startsWith(label))?.click();
    await nextTick();
};
const tickRow = async (name: string): Promise<void> => {
    [...document.body.querySelectorAll<HTMLLabelElement>(`[role=dialog] label`)]
        .find((row) => row.textContent?.includes(name))
        ?.querySelector<HTMLInputElement>(`input[type=checkbox]`)
        ?.click();
    await nextTick();
};
const tab = async (label: string): Promise<void> => {
    [...document.body.querySelectorAll<HTMLButtonElement>(`[role=tab]`)].find((button) => button.textContent?.trim() === label)?.click();
    await nextTick();
};
const areaRows = (): string[] =>
    [...document.body.querySelectorAll<HTMLLabelElement>(`[role=dialog] [role=group] label`)].map((row) => row.textContent?.trim() ?? ``);
const saveButton = (): HTMLButtonElement | undefined => buttonLabelled(`Send invite`) ?? buttonLabelled(`Save`);

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
    const writeText = jest.fn(async () => undefined);
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

// The link is the invite when mail did not carry it, and it can be read nowhere else: leaving the tab to open a chat
// app and coming back must still find it.
it(`keeps the link to carry across the tab closing and opening again`, async () => {
    create.mockResolvedValue({
        members: [{ email: `guest@example.com`, role: `collaborator`, status: `pending`, invitedAt: `2026-08-18T00:00:00.000Z` }],
        link: `https://localhost:47145/invite/tok`,
        delivery: `local-link`,
    });
    mount();
    await inviteEmail(`guest@example.com`);
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
    await inviteEmail(`guest@example.com`);

    expect(shown()).toContain(`The email was refused`);
    expect(shown()).toContain(`daily quota reached`);
    expect(shown()).toContain(`https://app.test/invite/tok`);
});

it(`names this browser and nothing it cannot list`, async () => {
    mount();
    await nextTick();

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
    await waitFor(() => expect(shown()).toContain(`nightly CI`));
    expect(shown()).toContain(`API tokens`);
    expect(shown()).toContain(`never used`);

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
});

// The daemon's POST /members bodies, in order.
const grantsSent = (): unknown[] =>
    // SAFETY: sandboxJson is called as (path, init) by sandboxRaw, and a POST's init carries its JSON body as a string.
    (sandboxJson.mock.calls as unknown[][])
        .filter(([path, init]) => path === `/members` && (init as { method?: string } | undefined)?.method === `POST`)
        .map(([, init]) => JSON.parse((init as { body: string }).body) as unknown);

const accepted = (tier: string) => ({ email: `guest@example.com`, role: tier, status: `accepted`, invitedAt: `2026-08-18T00:00:00.000Z` });

// A guest reaches the assistants that work in the areas it holds and nothing else, so the daemon refuses one that is
// unfenced or fenced where nobody works. The dialog holds the commit until the pick is one it would take, and then
// sends tier and fence as one grant.
it(`holds a member's move to guest until its fence reaches an assistant, then grants tier and fence together`, async () => {
    list.mockResolvedValue({ members: [accepted(`collaborator`)] });
    setRole.mockResolvedValue({ members: [accepted(`guest`)] });
    sandboxJson.mockImplementation(async (path: unknown) => (path === `/members` ? { members: daemonMembers() } : quiet(path)));
    mount();
    await settle();

    await openEdit(`guest@example.com`);
    await pickRole(`Guest`);
    // Nothing granted yet: the fence it needs is asked for, and the commit waits on it.
    expect(shown()).toContain(`A guest talks to the assistants that work there`);
    expect(saveButton()?.disabled).toBe(true);
    expect(grantsSent()).toEqual([]);

    await tickRow(`Support guest`);
    expect(saveButton()?.disabled).toBe(false);
    daemonMembers.mockReturnValue([{ email: `guest@example.com`, role: `guest`, areas: [`support`] }]);
    await commit();

    expect(grantsSent()).toEqual([{ email: `guest@example.com`, role: `guest`, areas: [`support`], emailSignIn: false, credentials: `all` }]);
    expect(setRole).toHaveBeenCalledWith({ sandboxId: `s1`, email: `guest@example.com`, role: `guest` });
    // The dialog goes, and the row now says who they talk to, which for this tier is the whole of what they can do.
    await waitFor(() => expect(dialog()).toBeNull());
    expect(shown()).toContain(`Talks to Support`);
});

// The refusal the owner cannot read off the fence itself: an area can name real folders and still hand over nobody.
it(`will not grant a guest fenced where no assistant works, and says what would fix it`, async () => {
    list.mockResolvedValue({ members: [accepted(`collaborator`)] });
    sandboxJson.mockImplementation(async (path: unknown) => (path === `/members` ? { members: daemonMembers() } : quiet(path)));
    mount();
    await settle();

    await openEdit(`guest@example.com`);
    await pickRole(`Guest`);
    // Finance names folders of its own, and no assistant starts in any of them.
    await tickRow(`Finance`);

    expect(saveButton()?.disabled).toBe(true);
    expect(shown()).toContain(`No assistant works in these folders`);
    expect(shown()).toContain(`give an assistant a starting folder in one of these areas`);
    await commit();
    expect(grantsSent()).toEqual([]);
    expect(setRole).not.toHaveBeenCalled();
});

// Fencing somebody at the tier they hold is one daemon write; the platform's record, which knows only the tier, is
// not touched. The absence of the field is the whole workspace, which is why an unfenced row sends no field.
it(`grants an area on an existing row, at the tier that row already holds`, async () => {
    list.mockResolvedValue({ members: [accepted(`collaborator`)] });
    sandboxJson.mockImplementation(async (path: unknown) => (path === `/members` ? { members: daemonMembers() } : quiet(path)));
    mount();
    await settle();

    // The row says where they work and what their assistants may use, in one line.
    expect(shown()).toContain(`Whole workspace · every connection and secret`);
    await openEdit(`guest@example.com`);
    expect(areaRows()).toEqual([]);
    expect(shown()).toContain(`They can talk to every assistant.`);
    await tab(`Only some areas`);
    expect(areaRows()).toEqual([`Support guestsupport`, `Financefinance`]);
    await tickRow(`Support guest`);
    daemonMembers.mockReturnValue([{ email: `guest@example.com`, role: `collaborator`, areas: [`support`] }]);
    await commit();

    expect(grantsSent()).toEqual([{ email: `guest@example.com`, role: `collaborator`, areas: [`support`], emailSignIn: false, credentials: `all` }]);
    expect(setRole).not.toHaveBeenCalled();
    expect(shown()).toContain(`Support guest · every connection and secret`);
});

// The tier decides what the rest of the form asks: a guest has no unfenced answer and each area says who it would
// hand over, and a maintainer is asked neither where nor with what, since that tier is the owner's authority.
it(`asks for an invite's areas in the terms of the role picked`, async () => {
    mount();
    await settle();
    await openInvite(`newcomer@example.com`);
    expect([...document.body.querySelectorAll(`[role=tab][aria-selected=true]`)].map((selected) => selected.textContent?.trim())).toContain(`Whole workspace`);

    await pickRole(`Guest`);
    expect(document.body.querySelector(`[role=tab]`)?.textContent).not.toContain(`Whole workspace`);
    expect(areaRows().find((row) => row.startsWith(`Support guest`))).toContain(`Support`);
    expect(areaRows().find((row) => row.startsWith(`Finance`))).toContain(`no assistant`);
    expect(shown()).toContain(`Pick at least one area.`);
    expect(document.body.querySelector(`[role=dialog] .ui-field-error`)).toBeNull();
    expect(saveButton()?.disabled).toBe(true);

    await tickRow(`Support guest`);
    expect(shown()).toContain(`They can talk to Support.`);
    expect(saveButton()?.disabled).toBe(false);

    await pickRole(`Maintainer`);
    expect(areaRows()).toEqual([]);
    expect(shown()).toContain(`A maintainer sees the whole workspace`);
    expect(shown()).toContain(`A maintainer can use every connection and secret.`);
});

// With no assistant homed in any area, no guest grant can be sent; that is said once, before any area is tried.
it(`tells the owner up front when no area has an assistant a guest could talk to`, async () => {
    const homed = personas.value;
    personas.value = [];
    try {
        mount();
        await settle();
        await openInvite(`newcomer@example.com`);
        await pickRole(`Guest`);
        expect(shown()).toContain(`No assistant works in any area yet, so a guest would have nobody to talk to.`);
    } finally {
        personas.value = homed;
    }
});

// A grant replaces the member's whole row on the daemon, so one sent while that roster is unread would drop the areas
// and the reach the row holds and widen what the member gets; the tab says so and opens nothing to rewrite them.
it(`rewrites no grant while it cannot read what each member holds`, async () => {
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
    expect(shown()).toContain(`Couldn't read what each member holds, so nobody's access can be changed until the sandbox answers.`);
    expect(document.body.querySelector<HTMLButtonElement>(`button[aria-label="Edit access for guest@example.com"]`)?.disabled).toBe(true);
    expect(grantsSent()).toEqual([]);
});

/* WHAT A PERSON'S ASSISTANTS MAY SPEND: decided in the same dialog and sent in the same grant, enforced by the sandbox. */

// Narrowing starts from nothing ticked, lists only what a reach can hold back, and names the rest as always available.
it(`limits what an invited person's assistants may use, and sends the list with the grant`, async () => {
    create.mockResolvedValue({ members: [], link: `https://localhost:47145/invite/tok`, delivery: `sent` });
    mount();
    await settle();
    await openInvite(`dee@corp.example`);

    await tab(`Only what I choose`);
    await settle();
    expect(shown()).toContain(`0 of 2 picked`);
    expect(shown()).toContain(`Always available, since there is no credential to hold back: Docker.`);
    await tickRow(`github`);
    expect(shown()).toContain(`1 of 2 picked`);
    await commit();

    expect(grantsSent()).toEqual([
        { email: `dee@corp.example`, role: `collaborator`, emailSignIn: true, credentials: { capabilities: [`github`], secrets: [] } },
    ]);
});

// The row reads the reach the daemon holds, so the line under a person says what their assistants may use.
it(`says on a member's row how much their assistants may use`, async () => {
    list.mockResolvedValue({ members: [accepted(`collaborator`)] });
    sandboxJson.mockImplementation(async (path: unknown) =>
        path === `/members`
            ? { members: [{ email: `guest@example.com`, role: `collaborator`, credentials: { capabilities: [`github`], secrets: [`DATABASE_URL`, `X`] } }] }
            : quiet(path),
    );
    mount();
    await settle();

    expect(shown()).toContain(`Whole workspace · 1 connection, 2 secrets`);
});

// Writer is the tier just under the maintainer floor these surfaces share, so it is the one a looser gate would let in.
it(`keeps the token surfaces off the tab of a member below maintainer`, async () => {
    role.value = `writer`;
    mount();
    await nextTick();
    expect(shown()).not.toContain(`API tokens`);
    expect(shown()).not.toContain(`Signed-in browsers`);
    expect(shown()).not.toContain(`Other ways in`);
});

// A maintainer holds the owner's operating authority, so the credential and door surfaces are theirs as well. The
// roster is the one part of this tab that stays the owner's: never read for them, never offered, and said so.
it(`gives a maintainer the token, sign-out and door surfaces, and keeps the roster the owner's`, async () => {
    role.value = `maintainer`;
    mount();
    await settle();

    expect(shown()).toContain(`API tokens`);
    expect(buttonLabelled(`Mint token`)?.disabled).toBe(false);
    expect(shown()).toContain(`Signed-in browsers`);
    expect(buttonLabelled(`Sign out all browsers`)?.disabled).toBe(false);
    expect(shown()).toContain(`Other ways in`);

    expect(list).not.toHaveBeenCalled();
    expect(document.body.querySelector(`input[type=email]`)).toBeNull();
    expect(shown()).toContain(`Only the sandbox owner can invite people or change roles.`);
});

// Every door read answers "none in use": a zero is a door nobody opened, so the group has nothing to say and is not drawn.
it(`leaves out the other ways in when no door is in use`, async () => {
    doorReads.automations.mockResolvedValue({ automations: [] });
    doorReads.workflows.mockResolvedValue({ workflows: [] });
    doorReads.ci.mockResolvedValue({ repos: [], runs: [] });
    doorReads.devices.mockResolvedValue({ devices: [] });
    sandboxJson.mockImplementation(async (path: unknown) => quiet(path));
    mount();
    await settle();

    expect(shown()).toContain(`Signed-in browsers`);
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
    await settle();
    expect(shown()).not.toContain(`Conversation permissions`);
    app?.unmount();
    document.body.innerHTML = ``;

    standing.value = [
        { conversationId: `c1`, capabilities: [`github`], folders: [], shelves: [], installs: false, secrets: [], everything: false, rules: [], releases: [] },
    ];
    mount();
    await settle();

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
    await settle();

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
    await settle();
    expect(shown()).toContain(`Sandbox-wide permissions`);
    expect(shown()).not.toContain(`Conversation permissions`);
    expect(shown()).toContain(`none of it stands until the file is fixed: hook sets, extensions.`);
});

/* EMAIL SIGN-IN: whether intentic's word for an address opens this sandbox for its person, decided with the invite and
   changed in the same dialog afterwards. */

it(`lets an invited address sign in with an email code by default`, async () => {
    create.mockResolvedValue({ members: [], link: `https://localhost:47145/invite/tok`, delivery: `sent` });
    mount();
    await settle();
    await inviteEmail(`dee@corp.example`);

    expect(grantsSent()).toEqual([{ email: `dee@corp.example`, role: `collaborator`, emailSignIn: true, credentials: `all` }]);
});

// Google already vouches for its own addresses: a second road for one is one the owner did not ask for.
it(`leaves it off for an address Google holds, unless the owner turns it on`, async () => {
    create.mockResolvedValue({ members: [], link: `https://localhost:47145/invite/tok`, delivery: `sent` });
    mount();
    await settle();
    const address = [`dee`, `gmail.com`].join(`@`);
    await openInvite(address);

    expect(shown()).toContain(`Can also sign in with a code sent to this address`);
    const toggle = document.body.querySelector<HTMLInputElement>(`[role=dialog] input[role="switch"]`);
    expect(toggle?.checked).toBe(false);
    await commit();

    expect(grantsSent()).toEqual([{ email: address, role: `collaborator`, emailSignIn: false, credentials: `all` }]);
});

// Changing how somebody signs in is one daemon write that carries their tier and fence as they stand (a grant replaces
// the row whole), and nothing for the platform, whose record has no way in to hold.
it(`changes a member's email sign-in with their tier and fence kept, at the sandbox alone`, async () => {
    list.mockResolvedValue({ members: [accepted(`collaborator`)] });
    daemonMembers.mockReturnValue([{ email: `guest@example.com`, role: `collaborator`, areas: [`support`] }]);
    sandboxJson.mockImplementation(async (path: unknown) => (path === `/members` ? { members: daemonMembers() } : quiet(path)));
    mount();
    await settle();

    await openEdit(`guest@example.com`);
    const toggle = document.body.querySelector<HTMLInputElement>(`[role=dialog] input[role="switch"]`);
    expect(toggle?.checked).toBe(false);
    toggle?.click();
    await nextTick();
    await commit();

    expect(grantsSent()).toEqual([{ email: `guest@example.com`, role: `collaborator`, areas: [`support`], emailSignIn: true, credentials: `all` }]);
    expect(setRole).not.toHaveBeenCalled();
});
