// @vitest-environment jsdom
//
// jsdom because the whole complaint about this tab was a fact about the rendered page: nineteen credentials one
// under another, each with the same furniture, burying the three rows that were actually work. What is pinned
// here is that the page stays short as the account list grows, that what is owed rises to the top of it, and
// that the accounts are still reachable: truncated is not gone, and a filter must reach every match or the
// search box would quietly lie about what this sandbox holds.
import type { CapabilitySummary } from "@intentic-app/api-contract";
import type { ExtensionSummary, SecretInventoryEntry } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// The tab's import chain pulls in app-wide singletons that read browser globals at import time (@intentic/ui's
// useDevice reads window.matchMedia; environment.ts reads window.env).

const inventory = ref<SecretInventoryEntry[]>([]);
vi.mock(`../../composables/secrets/useSecrets`, () => ({
    useSecretInventory: () => ({
        inventory,
        missingRequiredCount: ref(0),
        inventoryPending: ref(false),
        refreshInventory: () => {},
    }),
    useSecrets: () => ({ set: { mutateAsync: vi.fn() }, remove: { mutateAsync: vi.fn() } }),
    reveal: vi.fn(),
}));

const capabilities = ref<CapabilitySummary[]>([]);
vi.mock(`../../composables/extensions/useCapabilities`, () => ({
    useCapabilities: () => ({ capabilities }),
    useCapabilitySecret: () => ({ mutateAsync: vi.fn() }),
}));

const extensions = ref<ExtensionSummary[]>([]);
vi.mock(`../../composables/extensions/useExtensions`, () => ({ useExtensions: () => ({ enabled: extensions }) }));

// Reached only by the CI push, which nothing here presses: mocked because the client has no environment here.
vi.mock(`../../composables/sandbox/sandboxClient`, () => ({ sandboxRequest: vi.fn(), sandboxJson: vi.fn() }));

// The two "Manage …" controls are links now, so the mock carries a stand-in for them.
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRouter: () => ({ push: vi.fn() }) as never,
    RouterLink: (await import(`../../testing/routerLinkStub`)).RouterLinkStub as never,
}));

const { default: SandboxSecrets } = await import("./SandboxSecrets.vue");

const entry = (over: Partial<SecretInventoryEntry> & Pick<SecretInventoryEntry, `key` | `kind`>): SecretInventoryEntry => ({
    status: `set`,
    requiredBy: [],
    storedAt: `desired-state/.env`,
    revealable: true,
    ...over,
});

const capability = (id: string, kind: string, config: Record<string, string> = {}): CapabilitySummary =>
    ({ id, kind, status: { state: `active` }, config }) as CapabilitySummary;

const credential = (id: string): SecretInventoryEntry =>
    entry({ key: id, kind: `capability`, status: `connected`, storedAt: `.intentic/config/capabilities.json` });

// The sandbox in the report: sixteen identities the owner opened, three connectors, and a handful of real
// secrets underneath them.
const IDENTITIES = Array.from({ length: 16 }, (_, index) => `radarsuspam${index + 2}`);

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxSecrets) });
    app.component(`Icon`, defineComponent({ props: { name: String, spin: Boolean }, render: () => h(`i`) }));
    app.component(
        `RouterLink`,
        defineComponent({
            props: { to: String },
            setup:
                (_props, { slots }) =>
                () =>
                    h(`a`, slots[`default`]?.()),
        }),
    );
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

const text = (el: HTMLElement): string => el.textContent ?? ``;
const moreAccountsToggle = (el: HTMLElement): HTMLElement | null => {
    const all = ([...el.querySelectorAll(`*`)] as HTMLElement[]).filter((node) => node.textContent?.includes(`more accounts`));
    // The deepest element is the one actually rendering the toggle — clicking it bubbles up to the Row's @click handler.
    return all.at(-1) ?? null;
};
const filterField = (el: HTMLElement): HTMLInputElement => el.querySelector<HTMLInputElement>(`input[type="search"], input`)!;
const type = async (field: HTMLInputElement, value: string): Promise<void> => {
    field.value = value;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
};
// A row's own disclosure: the button holding the key, which is the only aria-expanded on the page.
const disclosures = (el: HTMLElement): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>(`button[aria-expanded]`)];

beforeEach(() => {
    capabilities.value = [
        capability(`devops`, `devops`),
        ...IDENTITIES.map((id) => capability(id, `identity`, { email: `${id}@gmail.com` })),
        capability(`github`, `cli`, { provider: `github` }),
        capability(`discord`, `cli`, { provider: `discord` }),
        capability(`komodo`, `cli`, { provider: `komodo` }),
    ];
    extensions.value = [];
    inventory.value = [
        entry({ key: `CF_API_TOKEN`, kind: `env`, status: `missing`, requiredBy: [{ resourceId: `shop-dns`, type: `dns` }] }),
        entry({ key: `SMTP_PASSWORD`, kind: `env` }),
        entry({ key: `DB_PASSWORD`, kind: `generated`, ci: { synced: false } }),
        ...IDENTITIES.map(credential),
        credential(`github`),
        credential(`discord`),
        credential(`komodo`),
        entry({ key: `claude:a1`, kind: `provider`, label: `Claude · you@example.com`, status: `connected`, revealable: false }),
    ];
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`truncates capability credentials once they would bury the secrets that are work`, () => {
    const el = mount();
    expect(text(el)).toContain(`Capability credentials`);
    expect(text(el)).toContain(`19`);
    expect(text(el)).toContain(`Show 16 more accounts`);
    expect(text(el)).toContain(`github`);
    expect(text(el)).not.toContain(`radarsuspam8`);
});

it(`shows every capability credential while there are few enough to read`, () => {
    inventory.value = inventory.value.filter((secret) => secret.kind !== `capability` || !secret.key.startsWith(`radarsuspam`));
    const el = mount();
    expect(moreAccountsToggle(el)).toBeNull();
    expect(text(el)).toContain(`github`);
});

it(`hides AI provider accounts entirely`, () => {
    const el = mount();
    expect(text(el)).not.toContain(`Claude · you@example.com`);
    expect(text(el)).not.toContain(`AI providers`);
});

it(`pins what is owed above everything, instead of a banner counting it`, () => {
    const el = mount();
    const heading = text(el).indexOf(`Needs attention`);
    expect(heading).toBeGreaterThanOrEqual(0);
    // The two debts, and the summary strip they replaced.
    expect(text(el)).toContain(`CF_API_TOKEN`);
    expect(text(el)).not.toContain(`required secret`);
    // Above the group it was lifted out of.
    expect(heading).toBeLessThan(text(el).indexOf(`Required by your intent`));
});

it(`names a credential by its account and its address, not by the key alone`, async () => {
    const el = mount();
    moreAccountsToggle(el)?.click();
    await nextTick();
    expect(text(el)).toContain(`radarsuspam7@gmail.com`);
});

it(`reaches every matching account while something is looked for`, async () => {
    const el = mount();
    await type(filterField(el), `radarsuspam7`);
    expect(text(el)).toContain(`radarsuspam7`);
    expect(text(el)).not.toContain(`radarsuspam8`);
    expect(moreAccountsToggle(el)).toBeNull();
});

it(`expands the account list when the toggle is pressed`, async () => {
    const el = mount();
    moreAccountsToggle(el)?.click();
    await nextTick();
    expect(text(el)).toContain(`radarsuspam8`);
    expect(text(el)).toContain(`Show less`);
});

it(`says so when a filter matches nothing, rather than showing an empty tab`, async () => {
    const el = mount();
    await type(filterField(el), `nothing-by-this-name`);
    expect(text(el)).toContain(`Nothing matches that filter`);
});

it(`keeps one row open at a time, so a list being scanned cannot grow under the pointer`, async () => {
    const el = mount();
    const rows = disclosures(el);
    rows[0]?.click();
    await nextTick();
    expect(disclosures(el).filter((row) => row.getAttribute(`aria-expanded`) === `true`)).toHaveLength(1);
    rows[1]?.click();
    await nextTick();
    expect(disclosures(el).filter((row) => row.getAttribute(`aria-expanded`) === `true`)).toHaveLength(1);
});
