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
const update = vi.fn<(id: string, input: { name?: string }) => Promise<SandboxSummary>>();
vi.mock(`../composables/sandbox/useSandbox`, () => ({
    useSandbox: () => ({ sandboxes, list, create, update, refresh: vi.fn().mockResolvedValue([]), select: vi.fn(), attach: vi.fn() }),
}));

// The mint never settles, so step 3 stays locked and these tests stay about step 1 — no command, no highlighter.
const setupCode = vi.fn(() => new Promise<never>(() => {}));
vi.mock(`../composables/useApi`, () => ({ apiClient: { sandbox: { setupCode } } }));
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
    // The mount read (list) and the create it decides on are two awaits deep.
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
    await nextTick();
    await nextTick();
    return el;
};

const buttonSaying = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((button) => button.textContent?.includes(text));

// The rename affordance is an icon now, so it is found the way a screen reader finds it. Its row is the one
// that reports the name — asserting on the row rather than the page keeps "workspace" from matching the
// page's own title ("Set up your workspace").
const renamePencil = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[aria-label="Rename sandbox"]`)!;
const nameRow = (): string => renamePencil().parentElement?.textContent ?? ``;

beforeEach(() => {
    sandboxes.value = [];
    list.mockReset().mockResolvedValue([]);
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
    expect(buttonSaying(`Create`)).toBeUndefined();
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
    buttonSaying(`Save`)!.click();
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(`new`, { name: `shop` }));
    await nextTick();
    expect(nameRow()).toContain(`shop`);
});
