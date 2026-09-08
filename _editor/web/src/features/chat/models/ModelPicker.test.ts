// @vitest-environment jsdom
// The model picker replaces the old sign-in-wall card; everything it offered lives in the list now:
// - the cheapest way in leads the locked rows, not sorted last by alphabet
// - every locked row still states its price
// - the accounts page link lives here, since nothing else offers it
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Catalogs are daemon-owned and refreshed on open; mocked to no-ops so the mount reflects only seeded state.
vi.mock(`./useChat-catalog`, () => ({
    loadAllProviderModels: () => Promise.resolve(),
    loadProviderModels: () => Promise.resolve(),
}));
vi.mock(`../accounts/useChat-accounts`, () => ({ refreshConnections: () => Promise.resolve() }));
// The runtime-health probe is the daemon's; silent here, which is its own "not probed yet" state.
vi.mock(`../../sandbox/overview/useSandboxVersion`, () => ({ useSandboxVersion: () => ({ runtimeIssue: () => undefined }) }));
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRouter: () => ({ push: vi.fn() }) as never,
    RouterLink: (await import(`../../../testing/routerLinkStub`)).RouterLinkStub as never,
}));

const { providerAccounts, translatorAccounts } = await import("../accounts/providerAccounts");
const { acpProviders, endpointProviders, perProvider, providerModels, trialStatus } = await import("../accounts/providerCatalog");
const { default: ModelPicker } = await import("./ModelPicker.vue");

let app: App | undefined;
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ModelPicker, { provider: `claude`, model: `claude-opus-4-6` }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

// Provider names in section order (the panel's own answer to what to look at first); read off the header's
// first span, since it also carries the price chip.
const headings = (element: HTMLElement): string[] =>
    [...element.querySelectorAll(`[role="presentation"] > span:first-child`)].map((node) => node.textContent?.trim() ?? ``);

const oneModel = (label: string) => [{ value: label.toLowerCase().replaceAll(` `, `-`), label }];

beforeEach(() => {
    // Nothing connected, every provider at its seed floor: the exact state a first-time user sees.
    providerAccounts.value = perProvider(() => []);
    translatorAccounts.value = { codex: [], grok: [], kimi: [], gemini: [] };
    acpProviders.value = [];
    endpointProviders.value = [];
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
    providerModels.value = {
        ...perProvider(() => []),
        claude: oneModel(`Claude Opus 4 6`),
        codex: oneModel(`GPT 5 6`),
        grok: oneModel(`Grok 4`),
        kimi: oneModel(`Kimi K3`),
        gemini: oneModel(`Gemini 3 Pro`),
    };
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`keeps the provider filters from adding a second vertical scroller beside the catalog`, () => {
    const element = mount();
    const rail = element.querySelector<HTMLElement>(`[role="radiogroup"]`)!;
    const list = element.querySelector<HTMLElement>(`#model-picker-list`)!;

    expect(rail.classList).toContain(`overflow-x-auto`);
    expect(rail.classList).not.toContain(`overflow-y-auto`);
    expect([...rail.querySelectorAll(`button`)].every((button) => button.classList.contains(`ui-row-select-horizontal`))).toBe(true);
    expect(list.classList).toContain(`overflow-y-auto`);
});

it(`leads the locked rows with the way in that costs nothing, and prices the rest`, () => {
    const element = mount();

    // Claude leads since it's the selected provider; free Google sign-in comes next, ahead of paid subscriptions.
    expect(headings(element).slice(0, 2)).toEqual([`Claude Code`, `Google`]);

    // And the price is on the row, so "free" is readable without connecting anything to find out.
    expect(element.textContent).toContain(`Free · Google sign-in`);
    expect(element.textContent).toContain(`Needs ChatGPT subscription`);
    // The pitch this panel replaced, in the words a new user actually read.
    expect(element.textContent).not.toContain(`Try free with Google`);
});

// The trial is a working row (a count, not a price): connected providers lead, cost only separates the locked ones.
it(`seats the working free trial above the locked rows, with its allowance rather than a price`, async () => {
    endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` }];
    trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };
    providerModels.value = { ...providerModels.value, [TRIAL_PROVIDER]: oneModel(`Free trial`) };
    const element = mount();
    await nextTick();

    expect(headings(element).slice(0, 3)).toEqual([`Claude Code`, `Free trial`, `Google`]);
    expect(element.textContent).toContain(String(trialStatus.value.remaining));
    expect(element.textContent).toContain(`trial`);
});

// The door to everything this list can only badge: a second account, dropping one, sign-in mechanics. The
// only route to the accounts page from chat.
it(`carries the way out to the accounts page, and drops it while searching`, async () => {
    const element = mount();

    const door = [...element.querySelectorAll(`a`)].find((link) => link.textContent?.includes(`All AI accounts`));
    expect(door?.getAttribute(`href`)).toBe(`/sandbox/agent`);

    // Searching turns the panel into one flat result set, where a standing footer reads as a result.
    const search = element.querySelector(`input`)!;
    search.value = `opus`;
    search.dispatchEvent(new Event(`input`));
    await nextTick();
    expect(element.textContent).not.toContain(`All AI accounts`);
});
