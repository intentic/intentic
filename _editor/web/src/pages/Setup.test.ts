// @vitest-environment jsdom
//
// WHAT SETUP ASKS FOR ON ARRIVAL, which is the whole subject: nothing. Step 1 used to be a form — an empty field
// and a Create button that stayed dead until a word was typed — and the word bought nothing, since a name only
// tells sandboxes apart in a switcher the visitor has not seen yet. These mount the real page and read the first
// frame: that a sandbox exists without anyone naming it, that arriving on one already made does NOT make a
// second, and that the name it was given is still the user's to change.
import type { SandboxSummary } from "@intentic-app/api-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// The import-time globals a mounted view needs (see Capabilities.test.ts): ui's useDevice reads matchMedia at
// module scope, environment.ts reads window.env and throws without it.
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
});

const push = vi.fn();
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () => ({ query: {} }) as never,
    useRouter: () => ({ push, replace: vi.fn() }) as never,
}));

// The sandbox registry, as the page sees it. `sandboxes` is what the auto-name counts against, `list` is the
// read on mount, and `create`/`update` are the two writes these tests are about.
const sandboxes = ref<SandboxSummary[]>([]);
const list = vi.fn<() => Promise<SandboxSummary[]>>();
const create = vi.fn<(name: string) => Promise<SandboxSummary>>();
const hostedProvision = vi.fn<(sandboxId: string) => Promise<SandboxSummary>>();
const hostedRelease = vi.fn<(sandboxId: string) => Promise<SandboxSummary>>();
const update = vi.fn<(id: string, input: { name?: string }) => Promise<SandboxSummary>>();
vi.mock(`../composables/sandbox/useSandbox`, () => ({
    useSandbox: () => ({
        sandboxes,
        list,
        create,
        hostedProvision,
        hostedRelease,
        update,
        refresh: vi.fn().mockResolvedValue([]),
        select: vi.fn(),
        attach: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
    }),
}));

// The mint never settles, so step 3 stays locked and these tests stay about step 1 — no command, no highlighter.
// The hosted offer answers "not on this platform" unless a test says otherwise — the classic lanes' tests must
// keep describing the world without the hosted rung.
const setupCode = vi.fn(() => new Promise<never>(() => {}));
const hostedOffer = vi.fn().mockResolvedValue({ enabled: false, remaining: 0 });
vi.mock(`../composables/useApi`, () => ({ apiClient: { sandbox: { setupCode, hostedOffer } } }));
vi.mock(`../composables/sandbox/sandboxIdFromToken`, () => ({ sandboxIdFromToken: vi.fn().mockResolvedValue(`0f310c3c4db4`) }));
vi.mock(`../composables/analytics`, () => ({ track: vi.fn() }));
vi.mock(`../composables/useAuth`, () => ({ useAuth: () => ({ user: ref({ email: `owner@example.com` }) }) }));
vi.mock(`../composables/useGoogleIdentity`, () => ({
    useGoogleIdentity: () => ({ getIdToken: vi.fn().mockResolvedValue(`id-token`), warmIdToken: vi.fn() }),
}));
vi.mock(`../composables/useNow`, () => ({ useNow: () => ref(0) }));
vi.mock(`../composables/extensions/useCloudflareZones`, () => ({
    useCloudflareZones: () => ({
        cfToken: ref(``),
        cfTokenValid: ref(false),
        selectedZone: ref(undefined),
        zones: ref([]),
        zonesLoading: ref(false),
        zonesError: ref(undefined),
    }),
}));
vi.mock(`../environments/desktop`, () => ({
    DESKTOP_DOWNLOADS: [],
    desktopSetupLink: () => ``,
    desktopVersion: () => undefined,
    openDesktopLink: vi.fn(),
}));
// Steps 2-3's own surfaces: separate components with their own concerns, and none of them step 1's.
vi.mock(`./SetupCompose.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./SetupHandoff.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./SetupRunDetails.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`../components/CloudflareTokenField.vue`, () => ({ default: defineComponent({ render: () => null }) }));

const { default: Setup } = await import("./Setup.vue");

const sandboxRow = (overrides: Partial<SandboxSummary> = {}): SandboxSummary =>
    ({
        id: `s1`,
        name: `workspace`,
        image: null,
        daemonUrl: null,
        lastSeenAt: null,
        setupCodeClaimedAt: null,
        token: `tok`,
        role: `owner`,
        providedTunnel: false,
        cloud: null,
        hosted: null,
        ...overrides,
    }) as SandboxSummary;

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(Setup) });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    app.directive(`tooltip`, {});
    app.mount(el);
    // The mount read (list + the hosted offer) and the create it decides on are several awaits deep — a
    // macrotask flushes the whole chained sequence where a fixed count of ticks kept going stale.
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    await nextTick();
    return el;
};

// A button whose whole label is this word — the "is there a Create button gating step 1" question, asked
// precisely. Substring matching answers it wrongly now that the ladder's cloud card says "Created in your own
// cloud account", which is prose about a machine rather than a control standing between the reader and their
// sandbox.
const buttonLabelled = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === text);

// The rename affordances are icons now, so they are found the way a screen reader finds them.
const renamePencil = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[aria-label="Rename sandbox"]`)!;
const saveName = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[aria-label="Save name"]`)!;

// The row that reports the name: climbed to from the pencil rather than read off a class, since the pencil and
// the value sit in separate cells of it (the in-place edit stacks each control over the one it replaces).
// Asserting on the row rather than the page keeps "workspace" from matching the page's own title, "Set up your
// workspace".
const nameRow = (): string => {
    let node: HTMLElement | null = renamePencil();
    while (node !== null && node.textContent?.includes(`Name`) !== true) {
        node = node.parentElement;
    }
    return node?.textContent ?? ``;
};

beforeEach(() => {
    sandboxes.value = [];
    list.mockReset().mockResolvedValue([]);
    hostedProvision.mockReset().mockImplementation(async (id: string) => sandboxRow({ id, hosted: { region: `iad` } }));
    hostedRelease.mockReset().mockImplementation(async (id: string) => sandboxRow({ id }));
    hostedOffer.mockReset().mockResolvedValue({ enabled: false, remaining: 0 });
    create.mockReset().mockImplementation(async (name: string) => {
        const row = sandboxRow({ id: `new`, name });
        sandboxes.value = [...sandboxes.value, row];
        return row;
    });
    update.mockReset().mockImplementation(async (id: string, input: { name?: string }) => sandboxRow({ id, name: input.name ?? `` }));
    push.mockReset();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// The regression this file is named for: a fresh account gets a sandbox by arriving, and is never shown a field.
it(`creates the sandbox on arrival, with no name asked for`, async () => {
    await mount();
    expect(create).toHaveBeenCalledWith(`workspace`);
    expect(nameRow()).toContain(`workspace`);
    expect(buttonLabelled(`Create`)).toBeUndefined();
});

// "Add sandbox" from a shell that already has one: the default counts past the names the account holds rather
// than colliding with them.
it(`numbers the next sandbox instead of colliding with the first`, async () => {
    const existing = sandboxRow({ id: `s1`, name: `workspace`, lastSeenAt: `2026-08-06T00:00:00.000Z` });
    sandboxes.value = [existing];
    list.mockResolvedValue([existing]);
    await mount();
    expect(create).toHaveBeenCalledWith(`workspace-2`);
});

// Leaving mid-setup and coming back is normal, and it must not pile up rows: the unfinished sandbox is resumed.
it(`resumes an unfinished sandbox rather than making a second`, async () => {
    const unfinished = sandboxRow({ id: `s1`, name: `my-laptop` });
    sandboxes.value = [unfinished];
    list.mockResolvedValue([unfinished]);
    await mount();
    expect(create).not.toHaveBeenCalled();
    expect(nameRow()).toContain(`my-laptop`);
});

// The name is a default, not a decision taken away: changing it is one click from the step that reports it, and
// it goes to the row this page created — never to whichever sandbox happens to be selected.
it(`renames the sandbox it created, from the step itself`, async () => {
    const el = await mount();
    renamePencil().click();
    await nextTick();
    const field = el.querySelector<HTMLInputElement>(`input`)!;
    field.value = `shop`;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
    saveName().click();
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(`new`, { name: `shop` }));
    await nextTick();
    expect(nameRow()).toContain(`shop`);
});

/* THE ZERO-CLICK FIRST RUN. On a platform that hosts, a fresh account's first sandbox is created AND started
 * without a single choice: the page creates the row the ordinary way, provisions a machine for it, and shows
 * the wait — no command, no copy button, nothing to paste. The classic tests above run with the offer
 * answering "disabled", which is every self-hosted platform and every platform from before the lane existed. */
it(`auto-starts a hosted machine on arrival when the platform offers one`, async () => {
    hostedOffer.mockResolvedValueOnce({ enabled: true, remaining: 1 });
    const el = await mount();
    // The row is created the ordinary way — the lane only decides what machine is attached to it.
    expect(create).toHaveBeenCalledWith(`workspace`);
    expect(hostedProvision).toHaveBeenCalledWith(`new`);
    expect(el.textContent).toContain(`Starting your machine`);
    // Nothing pasteable on the zero-click path: the wait is the whole step.
    expect(el.textContent).not.toContain(`Copy`);
});

/* A refused provision (allowance spent, capacity weather, a misconfigured platform) must not strand the first
 * run, AND must not hide why: the sandbox that was already created carries on into the command lane with the
 * reason on the step. The silent version of this — bounce lanes, wipe the message — is what made the page
 * read as broken. */
it(`keeps the sandbox and says why when the machine is refused`, async () => {
    hostedOffer.mockResolvedValueOnce({ enabled: true, remaining: 1 });
    hostedProvision.mockRejectedValue(new Error(`no capacity right now`));
    const el = await mount();
    expect(create).toHaveBeenCalledWith(`workspace`);
    expect(el.textContent).toContain(`no capacity right now`);
    expect(nameRow()).toContain(`workspace`);
});

// A hosted sandbox resumed mid-boot (the tab closed during "starting") continues as the hosted story it is —
// the wait card, never a command to run for a machine nobody has to touch.
it(`resumes a hosted sandbox onto the wait card, not the command lane`, async () => {
    const hosted = sandboxRow({ id: `h1`, name: `mine`, hosted: { region: `iad` } });
    sandboxes.value = [hosted];
    list.mockResolvedValue([hosted]);
    const el = await mount();
    expect(create).not.toHaveBeenCalled();
    expect(hostedProvision).not.toHaveBeenCalled();
    expect(el.textContent).toContain(`Starting your machine`);
});

/* THE LADDER IS CARDS, AND A SWITCH MOVES A MACHINE — NOT THE SANDBOX. Picking another rung on a hosted
 * sandbox hands its machine back and keeps the row: same id, same name, no delete-and-recreate. */
it(`offers the rungs as readable cards, each stating its trade`, async () => {
    hostedOffer.mockResolvedValueOnce({ enabled: true, remaining: 1 });
    const el = await mount();
    const cards = [...el.querySelectorAll(`[role="radio"]`)];
    expect(cards).toHaveLength(3);
    // Not a bare label each: the cost and what it asks of you are on the card, before it is clicked.
    expect(cards[0]?.textContent).toContain(`We host it`);
    expect(cards[0]?.textContent).toContain(`Free`);
    expect(cards[1]?.textContent).toContain(`needs Docker`);
});

it(`hands the machine back when another rung is chosen, keeping the same sandbox`, async () => {
    hostedOffer.mockResolvedValueOnce({ enabled: true, remaining: 1 });
    const el = await mount();
    const mine = [...el.querySelectorAll(`[role="radio"]`)].find((card) => card.textContent?.includes(`A computer I have`)) as HTMLButtonElement;
    mine.click();
    await vi.waitFor(() => expect(hostedRelease).toHaveBeenCalledWith(`new`));
    expect(create).toHaveBeenCalledTimes(1); // the row survived the switch
    await nextTick();
    expect(nameRow()).toContain(`workspace`);
});
