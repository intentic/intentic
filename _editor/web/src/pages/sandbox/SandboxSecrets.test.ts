// @vitest-environment jsdom
//
// jsdom because the whole complaint about this tab was a fact about the rendered page: nineteen credentials one
// under another, each with the same furniture, burying the three rows that were actually work. What is pinned
// here is that the page stays short as the account list grows, that what is owed rises to the top of it, and
// that the accounts are still reachable — folded is not gone, and a filter must reach inside the fold or the
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

// Reached only by the CI push, which nothing here presses — mocked because the client has no environment here.
vi.mock(`../../composables/sandbox/sandboxClient`, () => ({ sandboxRequest: vi.fn(), sandboxJson: vi.fn() }));

// The two "Manage …" buttons navigate; no route is mounted here, and RouterLink is stubbed below.
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
const fold = (el: HTMLElement): HTMLDetailsElement | null => el.querySelector(`details`);
const filterField = (el: HTMLElement): HTMLInputElement => el.querySelector<HTMLInputElement>(`input[type="search"], input`)!;
const type = async (field: HTMLInputElement, value: string): Promise<void> => {
    field.value = value;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
};
// A row's own disclosure — the button holding the key, which is the only aria-expanded on the page.
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

it(`folds the accounts away once they would bury the secrets that are work`, () => {
    const el = mount();
    expect(fold(el)?.open).toBe(false);
    // Folded, not hidden: the count is on the summary, so nothing can be concealed by the fold.
    expect(text(el)).toContain(`Connected accounts`);
    expect(text(el)).toContain(`20`);
});

it(`leaves the fold open while there are few enough accounts to read`, () => {
    inventory.value = inventory.value.filter((secret) => secret.kind !== `capability` || !secret.key.startsWith(`radarsuspam`));
    expect(fold(mount())?.open).toBe(true);
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

it(`names a credential by its account and its address, not by the key alone`, () => {
    expect(text(mount())).toContain(`radarsuspam7@gmail.com`);
});

it(`reaches inside the fold when something is looked for`, async () => {
    const el = mount();
    await type(filterField(el), `radarsuspam7`);
    expect(fold(el)?.open).toBe(true);
    expect(text(el)).toContain(`radarsuspam7`);
    expect(text(el)).not.toContain(`radarsuspam8`);
});

it(`does not fold the accounts back over a reader who opened them by hand`, async () => {
    const el = mount();
    const details = fold(el)!;
    // Opened by hand, then a search that forces it open anyway, then the search cleared.
    details.open = true;
    details.dispatchEvent(new Event(`toggle`));
    await nextTick();
    await type(filterField(el), `radarsuspam7`);
    await type(filterField(el), ``);
    expect(fold(el)?.open).toBe(true);
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
