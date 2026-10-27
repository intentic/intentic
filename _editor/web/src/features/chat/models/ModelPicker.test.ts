// The model picker replaces the old sign-in-wall card; everything it offered lives in the list now:
// - the cheapest way in leads the locked rows, not sorted last by alphabet
// - every locked row still states its price
// - the door to connecting one lives here, since nothing else in the picker offers it
import "@intentic/testing/dom";
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract/models/agent-catalog";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as vueRouterOriginal from "vue-router";
import { RouterLinkStub } from "../../../testing/routerLinkStub";

// Catalogs are daemon-owned and refreshed on open; mocked to no-ops so the mount reflects only seeded state.
jest.mock(`../../../models/conversations/accounts/useChat-catalog`, () => ({
    loadAllProviderModels: () => Promise.resolve(),
    loadProviderModels: () => Promise.resolve(),
}));
jest.mock(`../../../models/conversations/accounts/useChat-accounts`, () => ({ refreshConnections: () => Promise.resolve() }));
// The runtime-health probe is the daemon's; silent here, which is its own "not probed yet" state.
jest.mock(`../../../models/sandbox/useSandboxVersion`, () => ({ useSandboxVersion: () => ({ runtimeIssue: () => undefined, pairIssue: () => undefined }) }));
jest.mock(`vue-router`, () => ({
    ...vueRouterOriginal,
    useRouter: () => ({ push: jest.fn() }) as never,
    RouterLink: RouterLinkStub as never,
}));

// The AI accounts the reader is held to (Access ▸ People); undefined is every one, as for an owner.
const aiKeys = ref<readonly string[] | undefined>(undefined);
const realMembers = { ...(await import("../../../client/sandbox/useMembers")) };
jest.mock(`../../../client/sandbox/useMembers`, () => ({ ...realMembers, selfAiAccounts: () => computed(() => aiKeys.value) }));

const { providerAccounts, translatorAccounts } = await import("../../../models/providers/providerAccounts");
const { acpProviders, endpointProviders, perProvider, providerModels, trialStatus } = await import("../../../models/providers/providerCatalog");
const { default: ModelPicker } = await import("./ModelPicker.vue");
const { browsingCatalog } = await import("../../../models/providers/loadBrowsingCatalog");
const { NATIVE_PROVIDERS } = await import("@intentic/sandbox-contract/models/provider-specs");

let app: App | undefined;
const mountWith = (props: { readonly helperJobs?: boolean; readonly provider?: string; readonly model?: string }): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ModelPicker, { provider: `claude`, model: `claude-opus-4-6`, ...props }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};
const mount = (): HTMLElement => mountWith({});

// Provider names in section order (the panel's own answer to what to look at first); read off the header's
// first span, since it also carries the price chip.
const headings = (element: HTMLElement): string[] =>
    [...element.querySelectorAll(`[role="presentation"] > span:first-child`)].map((node) => node.textContent?.trim() ?? ``);

// The free sign-in's price chip, found by its words rather than its place, since where it sits is under test too.
const freeChip = (element: HTMLElement): Element | undefined =>
    [...element.querySelectorAll(`[role="presentation"] span`)].find((node) => node.textContent?.trim() === `Free · Google sign-in`);

// The one row the list folds the providers nothing here can run yet behind, while something can.
const disclosure = (element: HTMLElement): HTMLButtonElement | undefined =>
    [...element.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Add another provider`));

const oneModel = (label: string) => [{ value: label.toLowerCase().replaceAll(` `, `-`), label }];

beforeEach(() => {
    jest.spyOn(browsingCatalog, `refresh`).mockResolvedValue(undefined);
    aiKeys.value = undefined;
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
    browsingCatalog.snapshots.value = NATIVE_PROVIDERS.flatMap((provider) => {
        const models = providerModels.value[provider] ?? [];
        return models.length === 0 ? [] : [{ provider, verifiedAt: Date.now(), models: models.map((row) => ({ id: row.value, label: row.label })) }];
    });
    browsingCatalog.clock.value = Date.now();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    jest.restoreAllMocks();
    browsingCatalog.snapshots.value = [];
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
    // And lit, since for a reader who has connected nothing it is the one row that changes a decision.
    expect(freeChip(element)?.className).toContain(`text-accent`);
    // The pitch this panel replaced, in the words a new user actually read.
    expect(element.textContent).not.toContain(`Try free with Google`);
});

// Promotion is for the first-run reader only. Somebody who just connected Claude was told "connect Google for free"
// on every open; once any model is connected the free sign-in is one more locked row, in its usual place and quiet.
it(`stops pitching the free sign-in once a model is connected`, async () => {
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acct-1`, label: `Claude`, connectedAt: 0 }] };
    const element = mount();
    await nextTick();

    // What runs leads alone; every locked provider waits behind one row (onboarding review 2026-10-18, F10).
    expect(headings(element)).toEqual([`Claude Code`]);
    expect(freeChip(element)).toBeUndefined();
    expect(disclosure(element)?.textContent?.trim()).toBe(`Add another provider`);
    expect(disclosure(element)?.getAttribute(`aria-expanded`)).toBe(`false`);

    disclosure(element)?.click();
    await nextTick();
    expect(headings(element).slice(0, 5)).toEqual([`Claude Code`, `Codex`, `Grok`, `Kimi Code`, `Google`]);
    expect(disclosure(element)?.getAttribute(`aria-expanded`)).toBe(`true`);
    // The price still reads, since a reader comparing options wants it, but in the same chip as every other row.
    expect(freeChip(element)?.className).toContain(`text-subtle`);
    expect(freeChip(element)?.className).not.toContain(`text-accent`);
});

// The trial is a working row (a count, not a price): connected providers lead, cost only separates the locked ones.
it(`seats the working free trial above the locked rows, with its allowance rather than a price`, async () => {
    endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` }];
    trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };
    providerModels.value = { ...providerModels.value, [TRIAL_PROVIDER]: oneModel(`Free trial`) };
    const element = mount();
    await nextTick();

    // The lane the chat is on stays, locked or not; the trial is the one other thing that runs, and the catalogue of
    // accounts the reader does not have waits behind one row, cheapest first once opened.
    expect(headings(element)).toEqual([`Claude Code`, `Free trial`]);
    expect(element.textContent).toContain(`Free trial · 12 steps left today`);
    expect(disclosure(element)?.textContent?.trim()).toBe(`Add another provider`);

    disclosure(element)?.click();
    await nextTick();
    expect(headings(element).slice(0, 3)).toEqual([`Claude Code`, `Free trial`, `Google`]);
});

// Folded is not gone: a reader who types a provider's model still finds it.
it(`still finds a folded provider's models by search`, async () => {
    endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` }];
    trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };
    providerModels.value = { ...providerModels.value, [TRIAL_PROVIDER]: oneModel(`Free trial`) };
    const element = mount();
    await nextTick();
    expect(element.textContent).not.toContain(`Gemini 3 Pro`);

    const search = element.querySelector(`input`)!;
    search.value = `gemini`;
    search.dispatchEvent(new Event(`input`));
    await nextTick();

    expect([...element.querySelectorAll(`[role="option"]`)].map((row) => row.textContent?.replace(/\s+/g, ` `).trim())).toEqual([`Gemini 3 Pro`]);
    expect(disclosure(element)).toBeUndefined();
});

// The door to everything this list can only badge: connecting a first model, a second account, dropping one. A list
// of locked rows has to end somewhere a reader can act, and this is it.
it(`carries the way out to the connect view, and drops it while searching`, async () => {
    const element = mount();

    const door = [...element.querySelectorAll(`a`)].find((link) => link.textContent?.includes(`Connect a model`));
    expect(door?.getAttribute(`href`)).toBe(`/sandbox/models`);

    // Searching turns the panel into one flat result set, where a standing footer reads as a result.
    const search = element.querySelector(`input`)!;
    search.value = `opus`;
    search.dispatchEvent(new Event(`input`));
    await nextTick();
    expect(element.textContent).not.toContain(`Connect a model`);
});

// With nothing connected every row is locked, so the way to unlock them leads the list instead of ending it; once
// anything runs it goes back to the foot, as the door to a second account. Only once both reads have answered.
it(`leads with connecting a model while nothing here can run, and keeps the door at the foot once something can`, async () => {
    const { accountsLoaded } = await import("../../../models/providers/providerAccounts");
    const { endpointsLoaded } = await import("../../../models/providers/providerCatalog");
    accountsLoaded.value = true;
    endpointsLoaded.value = true;
    let element = mount();

    const first = element.querySelector(`[data-picker-connect-first]`);
    expect(first?.textContent).toContain(`Nothing is connected yet. Connect a model to start`);
    expect(first?.getAttribute(`href`)).toBe(`/sandbox/models`);
    expect(element.textContent).not.toContain(`Connect a model, or manage accounts`);
    app?.unmount();
    document.body.innerHTML = ``;

    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acct-1`, label: `Claude`, connectedAt: 0 }] };
    element = mount();
    expect(element.querySelector(`[data-picker-connect-first]`)).toBeNull();
    expect(element.textContent).toContain(`Connect a model, or manage accounts`);
    accountsLoaded.value = false;
    endpointsLoaded.value = false;
});

// A model that can only write one-shot jobs is listed, so a connected one does not seem to vanish, and refused for a turn
// with its reason where its description would be; a helper job's list may pick it.
it(`lists a helper-only model as refused for a turn, and pickable for a helper job`, () => {
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acct-1`, label: `Claude`, connectedAt: 0 }] };
    providerModels.value = {
        ...providerModels.value,
        claude: [...oneModel(`Claude Opus 4 6`), { value: `tiny`, label: `Tiny`, helperOnly: `no-tool-calls` }],
    };
    const row = (element: HTMLElement): HTMLButtonElement =>
        [...element.querySelectorAll<HTMLButtonElement>(`[role="option"]`)].find((button) => button.textContent?.includes(`Tiny`))!;

    const forChat = row(mount());
    expect(forChat.disabled).toBe(true);
    expect(forChat.textContent).toContain(`Helper jobs only: its server says it can't call tools`);
    app?.unmount();
    document.body.innerHTML = ``;

    const forHelper = row(mountWith({ helperJobs: true }));
    expect(forHelper.disabled).toBe(false);
    expect(forHelper.textContent).not.toContain(`Helper jobs only`);
});

it(`shows current browsing models while disconnected and switches to the connected account's own list`, async () => {
    browsingCatalog.snapshots.value = [{ provider: `claude`, verifiedAt: Date.now(), models: [{ id: `claude-opus-15`, label: `Claude Opus 15` }] }];
    browsingCatalog.clock.value = Date.now();
    const element = mount();
    expect(element.textContent).toContain(`Claude Opus 15`);
    expect(element.textContent).not.toContain(`Claude Opus 4 6`);
    expect(element.textContent).toContain(`Connect to check model availability.`);
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acct-1`, label: `Claude`, connectedAt: 0 }] };
    await nextTick();
    expect(element.textContent).toContain(`Claude Opus 4 6`);
    expect(element.textContent).not.toContain(`Claude Opus 15`);
});

it(`advertises the connection without stale model numbers when no current browsing catalog exists`, () => {
    browsingCatalog.snapshots.value = [];
    const element = mount();
    expect(element.textContent).toContain(`Connect to discover available models`);
    expect(element.textContent).not.toContain(`Claude Opus 4 6`);
    expect(element.textContent).not.toContain(`Couldn't load models`);
    expect(element.querySelectorAll(`[role="option"]`)).toHaveLength(0);
});

// A person held to some AI accounts (Access ▸ People) used to see every connected model lit and ticked, and found out at
// Send. What they can run leads; what is connected but not theirs waits behind one row that says so, and opened, it is
// listed and refused, with no Connect beside it, since connecting would not make it theirs.
describe(`for a person held to some AI accounts`, () => {
    const options = (element: HTMLElement): HTMLButtonElement[] => [...element.querySelectorAll<HTMLButtonElement>(`[role="option"]`)];
    const foldRow = (element: HTMLElement): HTMLButtonElement | undefined =>
        [...element.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.includes(`Models not shared with you`));

    beforeEach(async () => {
        const { accountsLoaded } = await import("../../../models/providers/providerAccounts");
        const { endpointsLoaded } = await import("../../../models/providers/providerCatalog");
        accountsLoaded.value = true;
        endpointsLoaded.value = true;
        providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acct-1`, label: `Claude Max`, connectedAt: 0 }] };
        translatorAccounts.value = { codex: [{ name: `chatgpt-ada`, label: `ada@acme.dev` }], grok: [], kimi: [], gemini: [] };
    });

    afterEach(async () => {
        const { accountsLoaded } = await import("../../../models/providers/providerAccounts");
        const { endpointsLoaded } = await import("../../../models/providers/providerCatalog");
        accountsLoaded.value = false;
        endpointsLoaded.value = false;
    });

    it(`leads with the models they can run and folds the rest behind a row that says they are not shared`, async () => {
        aiKeys.value = [`codex:chatgpt-ada`];
        const element = mountWith({ provider: `codex`, model: `gpt-5-6` });
        await nextTick();

        expect(headings(element)).toEqual([`Codex`]);
        expect(disclosure(element)).toBeUndefined();
        foldRow(element)?.click();
        await nextTick();

        expect(headings(element)[1]).toBe(`Claude Code`);
        expect(element.textContent).toContain(`Not shared with you`);
        // No price and no Connect on a lane connecting would not open to them.
        expect([...element.querySelectorAll(`a`)].some((link) => link.textContent?.trim() === `Connect`)).toBe(false);
        expect(element.textContent).not.toContain(`Needs ChatGPT subscription`);
        const claude = options(element).find((row) => row.textContent?.includes(`Claude Opus 4 6`));
        expect(claude?.disabled).toBe(true);
        expect(options(element).find((row) => row.textContent?.includes(`GPT 5 6`))?.disabled).toBe(false);
    });

    it(`says why on a withheld row found by search, where no lane header stands over it`, async () => {
        aiKeys.value = [`codex:chatgpt-ada`];
        const element = mountWith({ provider: `codex`, model: `gpt-5-6` });
        const search = element.querySelector(`input`)!;
        search.value = `opus`;
        search.dispatchEvent(new Event(`input`));
        await nextTick();

        const [row] = options(element);
        expect(row?.disabled).toBe(true);
        expect(row?.textContent).toContain(`Not shared with you`);
    });

    it(`says so when nothing connected is theirs, with asking the owner as the one press, never connecting`, async () => {
        // An endpoint that is gone: nothing here is theirs, connected or to connect.
        aiKeys.value = [`endpoint/gone`];
        const element = mount();
        await nextTick();

        const line = element.querySelector(`[data-picker-nothing-shared]`);
        expect(line?.textContent).toContain(`None of this sandbox's AI accounts is shared with you.`);
        expect(line?.textContent).toContain(`Ask for access`);
        expect(element.querySelector(`[data-picker-connect-first]`)).toBeNull();
        expect(element.textContent).not.toContain(`Connect a model, or manage accounts`);
        // Every lane waits behind the fold, so the list is the line and its way on rather than rows none can pick.
        expect(headings(element)).toEqual([]);
        expect(foldRow(element)?.getAttribute(`aria-expanded`)).toBe(`false`);
    });
});
