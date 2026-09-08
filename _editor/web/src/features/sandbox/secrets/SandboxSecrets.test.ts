// @vitest-environment jsdom
// needs jsdom: renders the real page. Pins that the list stays short as accounts grow, what's owed rises to the
// top, and a truncated or filtered account stays reachable, never silently dropped.
import type { CapabilitySummary } from "@intentic/api-contract";
import type { ExtensionSummary, SecretInventoryEntry } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Import chain touches window.matchMedia (@intentic/ui useDevice) and window.env (environment.ts) at import time.

const inventory = ref<SecretInventoryEntry[]>([]);
vi.mock(`../../capabilities/connect/useSecrets`, () => ({
    useSecretInventory: () => ({
        inventory,
        missingRequiredCount: ref(0),
        inventoryPending: ref(false),
        refreshInventory: () => {},
    }),
    useSecrets: () => ({ set: { mutateAsync: vi.fn() }, remove: { mutateAsync: vi.fn() } }),
    // Nothing gated, not the owner: keeps these cases about which rows show and how they're named. Gate behavior
    // itself is asserted in secretRows.test.ts.
    useCredentialGates: () => ({
        gates: ref([]),
        gateFor: () => undefined,
        approverChoices: ref([]),
        isOwner: ref(false),
        setGate: { mutateAsync: vi.fn() },
        removeGate: { mutateAsync: vi.fn() },
    }),
    reveal: vi.fn(),
}));

const capabilities = ref<CapabilitySummary[]>([]);
vi.mock(`../../capabilities/connect/useCapabilities`, () => ({
    useCapabilities: () => ({ capabilities }),
    useCapabilitySecret: () => ({ mutateAsync: vi.fn() }),
}));

const extensions = ref<ExtensionSummary[]>([]);
vi.mock(`../../extensions/useExtensions`, () => ({ useExtensions: () => ({ enabled: extensions }) }));

// Reached only by the CI push, which nothing here presses: mocked because the client has no environment here.
vi.mock(`../client/sandboxClient`, () => ({ sandboxRequest: vi.fn(), sandboxJson: vi.fn() }));

// The two "Manage..." controls are links now, so the mock carries a stand-in for them.
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRouter: () => ({ push: vi.fn() }) as never,
    RouterLink: (await import(`../../../testing/routerLinkStub`)).RouterLinkStub as never,
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

// Mirrors a real sandbox: sixteen identities, three connectors, a handful of real secrets.
const IDENTITIES = Array.from({ length: 16 }, (_, index) => `radarsuspam${index + 2}`);

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxSecrets) });
    app.component(`Icon`, IconStub);
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
    // Deepest matching element renders the toggle; the click bubbles up to the Row's handler.
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
    expect(text(el)).toContain(`CF_API_TOKEN`);
    expect(text(el)).not.toContain(`required secret`);
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
