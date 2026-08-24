// @vitest-environment jsdom
//
// THE QUICK MODEL ROW IS AN ORDER, and the claim under test is that what is on screen IS the order the daemon
// will walk: same list, same sequence, written straight back to the setting. A row that drew a list it did not
// write would be the worst possible version of this feature: the user reads "GPT, then Haiku", the sandbox
// spends something else, and nothing on either side says so.
//
// Mounted rather than projected because what is under test is the round trip a person performs: add a model,
// move it up, take it out, and each of those happens in the component's own handler.
import type { SandboxSettings } from "@intentic-app/api-contract";
import { SandboxSettingsSchema } from "@intentic-app/api-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";

// Same import-time browser globals the sibling suite stands in for (@intentic/ui's useDevice reads
// window.matchMedia; environment.ts reads window.env).

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = vi.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

vi.mock(`../../../composables/sandbox/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

// The tier readout's data source, a fixture like the settings above: what is under test is what the row SAYS
// over a given report, never the fetch behind it.
const savings = ref<{
    tier?: { judged: number; fast: number; atStakeUsd: number; routed: number; routedUsd: number; escalated: number; denied: number };
}>({});
vi.mock(`../../../composables/sandbox/useSavings`, () => ({
    useSavings: () => ({ savings, isLoading: ref(false), refetch: vi.fn(), error: ref(undefined) }),
}));

// Two connected accounts and one that is not: the whole point of this row is which of them a click spends, so
// the catalog it reads is the fixture, not a detail.
const CATALOGS: Record<string, readonly { value: string; label: string }[]> = {
    codex: [{ value: `gpt-5.6`, label: `GPT 5.6 Luna` }],
    claude: [{ value: `claude-haiku-4-5`, label: `Claude Haiku 4.5` }],
    gemini: [{ value: `gemini-3-flash-lite`, label: `Gemini 3 Flash Lite` }],
};
const connected = ref<readonly string[]>([`codex`, `claude`]);

vi.mock(`../../../composables/chat/access`, () => ({ providerReady: (provider: string) => connected.value.includes(provider) }));
vi.mock(`../../../composables/chat/providerCatalog`, () => ({
    endpointProviders: ref([]),
    modelOptionsFor: (provider: string) => CATALOGS[provider] ?? [],
    providerDisplayLabel: (provider: string) => provider.toUpperCase(),
}));
// The row below the one under test; it reads a different catalog and says nothing about the order.
vi.mock(`../../../composables/chat/modelPicker`, () => ({ pickerEntries: ref([]) }));
vi.mock(`../../../composables/chat/effortScale`, () => ({ effortsFor: () => [] }));

const { default: AgentModels } = await import("./AgentModels.vue");

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentModels) });
    app.use(PrimeVue);
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    settings.value = SandboxSettingsSchema.parse({});
    connected.value = [`codex`, `claude`];
    savings.value = {};
    patch.mockClear();
});

// The order as a person reads it off the screen: one entry per row, in the order the rows are drawn.
const orderOnScreen = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(`ol li`)].map((row) => row.querySelector(`span.flex-1`)?.textContent?.trim() ?? ``).filter((text) => text !== ``);

test("draws nothing but Auto's own ladder until a model is written down", async () => {
    const host = mount();
    await Promise.resolve();

    // Auto is a chain too, so the row names every rung rather than the word "Auto" on its own: this is the
    // whole discoverability story for a setting nobody has opened.
    expect(host.textContent).toContain(`Auto`);
    expect(host.textContent).toContain(`Claude Haiku 4.5`);
    expect(host.textContent).toContain(`GPT 5.6 Luna`);
    expect(orderOnScreen(host)).toEqual([]);
});

test("shows the pinned models in the order the setting holds them", async () => {
    settings.value = { ...settings.value, quickModel: [`codex:gpt-5.6`, `claude:claude-haiku-4-5`] };
    const host = mount();
    await Promise.resolve();

    expect(orderOnScreen(host)).toEqual([`CODEX · GPT 5.6 Luna`, `CLAUDE · Claude Haiku 4.5`]);
});

test("moving one earlier writes the whole new order back", async () => {
    settings.value = { ...settings.value, quickModel: [`codex:gpt-5.6`, `claude:claude-haiku-4-5`] };
    const host = mount();
    await Promise.resolve();

    const rows = [...host.querySelectorAll(`ol li`)];
    // The first row has nowhere above it to go, so its button is off rather than a no-op that looks live.
    expect((rows[0]!.querySelector(`button`) as HTMLButtonElement).disabled).toBe(true);
    (rows[1]!.querySelector(`button`) as HTMLButtonElement).click();

    expect(patch).toHaveBeenCalledWith({ quickModel: [`claude:claude-haiku-4-5`, `codex:gpt-5.6`] });
});

test("removing the last one hands the choice back to Auto rather than leaving an empty control", async () => {
    settings.value = { ...settings.value, quickModel: [`codex:gpt-5.6`] };
    const host = mount();
    await Promise.resolve();

    const remove = [...host.querySelectorAll(`ol li button`)].at(-1) as HTMLButtonElement;
    remove.click();

    expect(patch).toHaveBeenCalledWith({ quickModel: [] });
});

test("keeps a pin whose account went away on screen, and says why it is greyed", async () => {
    // The resolver drops it at run time so the helpers keep working. Dropping it from the ROW as well would
    // look like the app had eaten a setting the user made.
    settings.value = { ...settings.value, quickModel: [`gemini:gemini-3-flash-lite`, `claude:claude-haiku-4-5`] };
    const host = mount();
    await Promise.resolve();

    expect(orderOnScreen(host)).toEqual([`GEMINI · Gemini 3 Flash Lite`, `CLAUDE · Claude Haiku 4.5`]);
    expect(host.textContent).toContain(`Not connected`);
});

/* THE AUTOMATIC-TIER ROW is the only setting on this page that can override a model the user picked a second
 * ago, so what these pin is the two things a reader has to be able to trust: that its DEFAULT changes nothing,
 * and that the screen says so. A control whose default has no visible effect reads as broken unless the row
 * states that having no effect IS the effect. */

// The three-way mode control, by the label a person clicks.
const modeButton = (host: HTMLElement, label: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>(`[role="tablist"] button`)].find((button) => button.textContent?.trim() === label)!;

test("defaults to measuring", async () => {
    const host = mount();
    await Promise.resolve();

    expect(settings.value.autoTier).toBe(`shadow`);
    expect(modeButton(host, `Measure`).getAttribute(`aria-selected`)).toBe(`true`);
});

test("switching the mode writes it, and the row then describes what it actually does", async () => {
    const host = mount();
    await Promise.resolve();
    modeButton(host, `On`).click();

    expect(patch).toHaveBeenCalledWith({ autoTier: `on` });
    await Promise.resolve();
    expect(host.textContent).toContain(`run on the cheaper model`);
});

test("off says the judgement stops too, not merely the routing", async () => {
    // "Off" that kept scoring in the background would be a setting that does not mean what it says.
    const host = mount();
    await Promise.resolve();
    modeButton(host, `Off`).click();
    await Promise.resolve();

    expect(host.textContent).toContain(`Nothing is judged or recorded`);
});

test("names the rule behind Auto, because which model it picks depends on a conversation this page cannot see", async () => {
    const host = mount();
    await Promise.resolve();

    expect(host.textContent).toContain(`cheapest from the chat`);
});

test("a pinned cheap model is drawn as written, in its own list", async () => {
    settings.value = { ...settings.value, autoFastModels: [`claude:claude-haiku-4-5`] };
    const host = mount();
    await Promise.resolve();

    expect(orderOnScreen(host)).toEqual([`CLAUDE · Claude Haiku 4.5`]);
});

test("the judge's record renders its three numbers once turns have been judged", async () => {
    savings.value = { tier: { judged: 40, fast: 10, atStakeUsd: 1.5, routed: 4, routedUsd: 0.25, escalated: 1, denied: 2 } };
    const host = mount();
    await Promise.resolve();

    expect(host.textContent).toContain(`10 of 40`);
    expect(host.textContent).toContain(`4 down-routed`);
    expect(host.textContent).not.toContain(`$1.50`);
    expect(host.textContent).toContain(`1/10 bumped up`);
    expect(host.textContent).toContain(`2 vetoed`);
});

test("no judged turns means no numbers at all: absence, not a row of zeros", async () => {
    const host = mount();
    await Promise.resolve();

    expect(host.textContent).not.toContain(`Last 30 days`);
});

/* THE ONE DIAL. It is the answer to the numbers above it, so what these pin is that it is reachable from the
 * same screen, that it writes what it says, and that it disappears with the feature rather than sitting there
 * adjusting a judge that never runs. */

test("the dial defaults to balanced and writes the stop that was clicked", async () => {
    const host = mount();
    await Promise.resolve();

    expect(modeButton(host, `Balanced`).getAttribute(`aria-selected`)).toBe(`true`);
    modeButton(host, `Eager`).click();

    expect(patch).toHaveBeenCalledWith({ autoTierEagerness: `eager` });
});

test("the eagerness dial goes away with the feature, not just the mode control", async () => {
    const host = mount();
    await Promise.resolve();
    modeButton(host, `Off`).click();
    await Promise.resolve();

    expect(host.textContent).not.toContain(`Cautious`);
});

test("the dial goes away with the feature, rather than adjusting a judge that never runs", async () => {
    const host = mount();
    await Promise.resolve();
    modeButton(host, `Off`).click();
    await Promise.resolve();

    expect(host.textContent).not.toContain(`How readily`);
});
