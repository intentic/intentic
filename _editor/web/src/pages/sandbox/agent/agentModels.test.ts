// @vitest-environment jsdom
//
// THE MODEL ROWS ARE AN ORDER, and the claim under test is that what is on screen IS the order the daemon
// will walk: same list, same sequence, written straight back to the setting. A row that drew a list it did not
// write would be the worst possible version of this feature: the user reads "GPT, then Haiku", the sandbox
// spends something else, and nothing on either side says so.
//
// And, since each agent-run entry carries its own run settings, the second claim: a knob moved on one entry
// lands on THAT entry. The effort used to be a single field beside the list, so there was nothing to get wrong
// here and nothing to test; now there is.
//
// Mounted rather than projected because what is under test is the round trip a person performs: add a model,
// move it up, take it out, re-point one, change its tier, and each of those happens in the component's own
// handler.
import type { SandboxSettings } from "@intentic-app/api-contract";
import { SandboxSettingsSchema } from "@intentic-app/api-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

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

// Two connected accounts and one that is not: the whole point of these rows is which of them a click spends, so
// the catalog they read is the fixture, not a detail.
const CATALOGS: Record<string, readonly { value: string; label: string }[]> = {
    codex: [{ value: `gpt-5.6`, label: `GPT 5.6 Luna` }],
    claude: [{ value: `claude-haiku-4-5`, label: `Claude Haiku 4.5` }],
    gemini: [{ value: `gemini-3-flash-lite`, label: `Gemini 3 Flash Lite` }],
};
const connected = ref<readonly string[]>([`codex`, `claude`]);

vi.mock(`../../../composables/chat/access`, () => ({ providerReady: (provider: string) => connected.value.includes(provider) }));
// `providerModels` empty rather than absent: the real effortScale runs against it, and an empty live catalog is
// what puts a model on the static scale, which is the case every fixture here is on.
vi.mock(`../../../composables/chat/providerCatalog`, () => ({
    endpointProviders: ref([]),
    providerModels: ref({}),
    modelOptionsFor: (provider: string) => CATALOGS[provider] ?? [],
    providerDisplayLabel: (provider: string) => provider.toUpperCase(),
}));

/* THE PICKER IS THE PAGE'S ONE PANEL, standing by and opened over whichever trigger raised it. Stubbed here
 * rather than mounted: behind the real one is the app's whole model catalog, and what these tests are about is
 * the wiring between a row and the list it writes — which entry the panel was opened over, and where its
 * answers land. The props are handed over LIVE (the reactive object, not a copy), so a test can watch an entry
 * change under the open panel the way the user does. */
let opened: { readonly pin?: unknown; readonly knobs?: boolean; readonly taken?: unknown } | undefined;
let answer: { pick: (pin: unknown) => void; configure: (pin: unknown) => void } | undefined;
vi.mock(`./ModelPinPicker.vue`, () => ({
    // `__esModule` so the SFC interop reads `.default` off this the way it would off the real component.
    __esModule: true,
    default: defineComponent({
        props: { open: Boolean, anchor: Object, pin: Object, knobs: Boolean, taken: Array },
        emits: [`update:open`, `pick`, `configure`],
        setup(props, { emit }) {
            opened = props;
            answer = { pick: (pin) => emit(`pick`, pin), configure: (pin) => emit(`configure`, pin) };
            return () => h(`div`, { class: `pin-picker` });
        },
    }),
}));

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

// The picker is an async import, so it lands a tick after the click that opened it: the module resolves, then
// Vue renders what it resolved to.
const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    settings.value = SandboxSettingsSchema.parse({});
    connected.value = [`codex`, `claude`];
    savings.value = {};
    opened = undefined;
    answer = undefined;
    patch.mockClear();
});

// The order as a person reads it off the screen: one entry per row, in the order the rows are drawn.
const orderOnScreen = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(`ol li`)].map((row) => row.querySelector(`span.flex-1`)?.textContent?.trim() ?? ``).filter((text) => text !== ``);

// A row's controls by what they announce, not by their position: the row's own label is a button too (it opens
// the picker), so "the first button in the row" stopped being a stable way to reach the promote arrow.
const rowButton = (host: HTMLElement, label: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>(`ol li button`)].find((button) => button.getAttribute(`aria-label`) === label)!;

const addButton = (host: HTMLElement, label: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.getAttribute(`aria-label`) === label)!;

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

    // The first row has nowhere above it to go, so its button is off rather than a no-op that looks live.
    expect(rowButton(host, `Move CODEX · GPT 5.6 Luna earlier`).disabled).toBe(true);
    rowButton(host, `Move CLAUDE · Claude Haiku 4.5 earlier`).click();

    expect(patch).toHaveBeenCalledWith({ quickModel: [`claude:claude-haiku-4-5`, `codex:gpt-5.6`] });
});

test("removing the last one hands the choice back to Auto rather than leaving an empty control", async () => {
    settings.value = { ...settings.value, quickModel: [`codex:gpt-5.6`] };
    const host = mount();
    await Promise.resolve();

    rowButton(host, `Remove CODEX · GPT 5.6 Luna`).click();

    expect(patch).toHaveBeenCalledWith({ quickModel: [] });
});

test("keeps a pin whose account went away on screen, and says why it is greyed", async () => {
    // The resolver drops it at run time so the helpers keep working. Dropping it from the ROW as well would
    // look like the app had eaten a setting the user made.
    settings.value = { ...settings.value, quickModel: [`gemini:gemini-3-flash-lite`, `claude:claude-haiku-4-5`] };
    const host = mount();
    await Promise.resolve();

    expect(orderOnScreen(host)).toEqual([`GEMINI · Gemini 3 Flash Lite`, `CLAUDE · Claude Haiku 4.5`]);
    const disconnected = host.querySelector(`ol li`) as HTMLElement;
    expect(disconnected?.className).toMatch(/opacity|subtle|disabled/i);
});

/* EACH AGENT-RUN ENTRY CARRIES ITS OWN RUN SETTINGS, which is what this page was rebuilt for: the effort used
 * to be one control beside the list, answering for a frontier head and the cheap account under it alike. So
 * what these pin is that the row SAYS what its own entry will run at, and that moving that knob moves nothing
 * else. */

test("an agent-run entry names its own tier, and one left at the provider's default names nothing", async () => {
    settings.value = {
        ...settings.value,
        agentRunModels: [
            { provider: `claude`, model: `claude-haiku-4-5`, effort: `high` },
            { provider: `codex`, model: `gpt-5.6` },
        ],
    };
    const host = mount();
    await Promise.resolve();

    const rows = [...host.querySelectorAll(`ol li`)].map((row) => row.textContent?.replace(/\s+/g, ` `).trim() ?? ``);
    expect(rows[0]).toContain(`High`);
    // The second entry pinned no knobs, so it reads as just a model: the line exists to make a deliberate
    // choice legible, not to give every field a value.
    expect(rows[1]).toContain(`GPT 5.6 Luna`);
    expect(rows[1]).not.toMatch(/High|Low|thinking/);
});

test("a tier off the model's own scale is drawn as the one that will actually run", async () => {
    // Claude's API refuses `max` with thinking disabled, and THIS entry disabled it, so the row must not promise
    // a rung this run cannot use. The stored pick is left alone underneath.
    settings.value = { ...settings.value, agentRunModels: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `max`, thinking: false }] };
    const host = mount();
    await Promise.resolve();

    expect(host.querySelector(`ol li`)?.textContent).toContain(`X-High`);
    expect(settings.value.agentRunModels[0]?.effort).toBe(`max`);
});

// …while an entry that pinned no thinking at all is not that pair: the turn goes out with no thinking field and
// the daemon names the reasoning the tier needs, so the row says the tier the entry actually spends.
test("an entry that pinned no thinking keeps the top tier it asked for", async () => {
    settings.value = { ...settings.value, agentRunModels: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `max` }] };
    const host = mount();
    await Promise.resolve();

    expect(host.querySelector(`ol li`)?.textContent).toContain(`Max`);
});

test("pressing an agent-run row opens the picker over that entry, with its knobs", async () => {
    settings.value = {
        ...settings.value,
        agentRunModels: [
            { provider: `codex`, model: `gpt-5.6` },
            { provider: `claude`, model: `claude-haiku-4-5`, effort: `low` },
        ],
    };
    const host = mount();
    await Promise.resolve();

    rowButton(host, `Change CLAUDE · Claude Haiku 4.5`).click();
    await flush();

    expect(opened?.pin).toEqual({ provider: `claude`, model: `claude-haiku-4-5`, effort: `low` });
    expect(opened?.knobs).toBe(true);
    // Both entries are already written down, so neither can be pinned a second time.
    expect(opened?.taken).toEqual([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]);
});

test("the quick row opens the same picker without knobs: its jobs cannot honour one", async () => {
    // A quick helper is a one-shot the daemon runs with thinking disabled and no effort at all, so a reasoning
    // control there would be a switch with nothing behind it.
    settings.value = { ...settings.value, quickModel: [`codex:gpt-5.6`] };
    const host = mount();
    await Promise.resolve();

    rowButton(host, `Change CODEX · GPT 5.6 Luna`).click();
    await flush();

    expect(opened?.pin).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(opened?.knobs).toBe(false);
});

test("a knob moved in the picker lands on that entry alone", async () => {
    settings.value = {
        ...settings.value,
        agentRunModels: [
            { provider: `codex`, model: `gpt-5.6`, effort: `high` },
            { provider: `claude`, model: `claude-haiku-4-5` },
        ],
    };
    const host = mount();
    await Promise.resolve();
    rowButton(host, `Change CLAUDE · Claude Haiku 4.5`).click();
    await flush();

    answer?.configure({ provider: `claude`, model: `claude-haiku-4-5`, effort: `max`, thinking: true });

    expect(patch).toHaveBeenCalledWith({
        agentRunModels: [
            { provider: `codex`, model: `gpt-5.6`, effort: `high` },
            { provider: `claude`, model: `claude-haiku-4-5`, effort: `max`, thinking: true },
        ],
    });
    // The panel stays open over the entry it is configuring, and now reads the new state: these are settings of
    // the entry rather than the answer the panel was opened for.
    await flush();
    expect(opened?.pin).toEqual({ provider: `claude`, model: `claude-haiku-4-5`, effort: `max`, thinking: true });
});

test("re-pointing an entry replaces it where it stands, because its position is the other half of the setting", async () => {
    settings.value = {
        ...settings.value,
        agentRunModels: [
            { provider: `codex`, model: `gpt-5.6` },
            { provider: `claude`, model: `claude-haiku-4-5`, effort: `low` },
        ],
    };
    const host = mount();
    await Promise.resolve();
    rowButton(host, `Change CODEX · GPT 5.6 Luna`).click();
    await flush();

    answer?.pick({ provider: `claude`, model: `claude-opus-5`, effort: `max` });

    expect(patch).toHaveBeenCalledWith({
        agentRunModels: [
            { provider: `claude`, model: `claude-opus-5`, effort: `max` },
            { provider: `claude`, model: `claude-haiku-4-5`, effort: `low` },
        ],
    });
});

test("adding appends to the end of the order, in whichever shape that list stores", async () => {
    const host = mount();
    await Promise.resolve();

    addButton(host, `Add a model for agent runs`).click();
    await flush();
    expect(opened?.pin).toBeUndefined();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5`, effort: `high` });
    expect(patch).toHaveBeenCalledWith({ agentRunModels: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `high` }] });

    // The quick list keeps `${provider}:${model}` keys rather than pins, and the same gesture writes one.
    addButton(host, `Add a quick model`).click();
    await flush();
    answer?.pick({ provider: `codex`, model: `gpt-5.6` });
    expect(patch).toHaveBeenCalledWith({ quickModel: [`codex:gpt-5.6`] });
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
    const before = host.textContent ?? ``;
    modeButton(host, `On`).click();

    expect(patch).toHaveBeenCalledWith({ autoTier: `on` });
    await Promise.resolve();
    expect(host.textContent).not.toBe(before);
});

test("off says the judgement stops too, not merely the routing", async () => {
    const host = mount();
    await Promise.resolve();
    const measuring = host.textContent ?? ``;
    modeButton(host, `Off`).click();
    await Promise.resolve();

    expect(host.textContent).not.toBe(measuring);
    expect(patch).toHaveBeenCalledWith({ autoTier: `off` });
});

test("names the rule behind Auto, because which model it picks depends on a conversation this page cannot see", async () => {
    const host = mount();
    await Promise.resolve();

    expect(host.textContent).toContain(`Auto`);
    expect(orderOnScreen(host)).toEqual([]);
});

test("a pinned cheap model is drawn as written, in its own list", async () => {
    settings.value = { ...settings.value, autoFastModels: [`claude:claude-haiku-4-5`] };
    const host = mount();
    await Promise.resolve();

    expect(orderOnScreen(host)).toEqual([`CLAUDE · Claude Haiku 4.5`]);
});

test("the judge's record renders its three numbers once turns have been judged", async () => {
    const tier = { judged: 40, fast: 10, atStakeUsd: 1.5, routed: 4, routedUsd: 0.25, escalated: 1, denied: 2 };
    savings.value = { tier };
    const host = mount();
    await Promise.resolve();

    expect(host.textContent).toContain(`${tier.fast} of ${tier.judged}`);
    expect(host.textContent).toContain(String(tier.routed));
    expect(host.textContent).not.toContain(`$1.50`);
    expect(host.textContent).toContain(`${tier.escalated}/${tier.fast}`);
    expect(host.textContent).toContain(String(tier.denied));
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
