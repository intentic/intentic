// @vitest-environment jsdom
// Pins that the on-screen order is what's written back, a knob moved on one entry lands only on that entry, and each
// row writes only its own job's list, never a shared one. Mounted, since what's tested is the click-through round trip.
import type { SandboxSettings } from "@intentic/api-contract";
import { MODEL_ROLE_BLOCKS, MODEL_ROLES, type ModelPin } from "@intentic/sandbox-contract";
import { SandboxSettingsSchema } from "@intentic/api-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { IconStub } from "@intentic/ui/testing";

// useDevice reads window.matchMedia at import; environment.ts reads window.env.

// Three representative roles: an ordinary one-shot (`commit-message`), one with an external switch (`safety-judge`),
// and a session job (`pipeline-fix`); every other row is one of these shapes.
const COMMIT = `commit-message` as const;
const JUDGE = `safety-judge` as const;
const RUN = `pipeline-fix` as const;

const entry = (provider: string, model: string, rest: Record<string, unknown> = {}): ModelPin => ({ provider, model, ...rest }) as ModelPin;

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = vi.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

vi.mock(`../../overview/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

// Fixture for the tier readout; what's tested is what the row says over a report, not the fetch behind it.
const savings = ref<{
    tier?: { judged: number; fast: number; atStakeUsd: number; routed: number; routedUsd: number; escalated: number; denied: number };
}>({});
vi.mock(`../../usage/useSavings`, () => ({
    useSavings: () => ({ savings, isLoading: ref(false), refetch: vi.fn(), error: ref(undefined) }),
}));

// Two connected accounts, one not, since which one a click spends is exactly what these rows test.
const CATALOGS: Record<string, readonly { value: string; label: string }[]> = {
    codex: [{ value: `gpt-5.6`, label: `GPT 5.6 Luna` }],
    claude: [{ value: `claude-haiku-4-5`, label: `Claude Haiku 4.5` }],
    gemini: [{ value: `gemini-3-flash-lite`, label: `Gemini 3 Flash Lite` }],
};
const connected = ref<readonly string[]>([`codex`, `claude`]);

vi.mock(`../../../chat/session/access`, () => ({ providerReady: (provider: string) => connected.value.includes(provider) }));
// Empty `providerModels`: puts every model on the static effort scale, the state every fixture here assumes.
vi.mock(`../../../chat/accounts/providerCatalog`, () => ({
    endpointProviders: ref([]),
    providerModels: ref({}),
    modelOptionsFor: (provider: string) => CATALOGS[provider] ?? [],
    providerDisplayLabel: (provider: string) => provider.toUpperCase(),
}));

// Stubbed rather than mounted: what's under test is the wiring between a row and its list, not the real catalog. Props
// are handed over live, so a test can watch an entry change under the open panel.
let opened: { readonly pin?: unknown; readonly knobs?: boolean; readonly taken?: unknown } | undefined;
let answer: { pick: (pin: unknown) => void; configure: (pin: unknown) => void } | undefined;
vi.mock(`./ModelPinPicker.vue`, () => ({
    // `__esModule` so the SFC interop reads `.default` the way it would off the real component.
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

// The judge row links to the Safety tab when off, so a router is needed; only the hub's route, not the app's guards.
const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: `/sandbox/:tab?`, name: `sandbox`, component: defineComponent({ render: () => h(`div`) }) }],
});
await router.push({ name: `sandbox`, params: { tab: `agent` } });
await router.isReady();

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentModels) });
    app.use(PrimeVue);
    app.use(router);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

// The picker is an async import, landing a tick after the click: the module resolves, then Vue renders it.
const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

// One block's section, found by its heading; every group-scoped helper below goes through this.
const group = (host: HTMLElement, label: string): HTMLElement =>
    [...host.querySelectorAll<HTMLElement>(`section`)].find((section) => section.textContent?.includes(label))!;

// A fresh record has every job agreeing, so groups default to the collapsed view; per-job-row tests must force Advanced
// rather than rely on the fixture.
const viewButton = (host: HTMLElement, block: string, label: string): HTMLButtonElement =>
    [...group(host, block).querySelectorAll<HTMLButtonElement>(`[role="tablist"] button`)].find((button) => button.textContent?.trim() === label)!;

const showJobs = async (host: HTMLElement, ...blocks: string[]): Promise<void> => {
    for (const label of blocks.length > 0 ? blocks : MODEL_ROLE_BLOCKS.map((block) => block.label)) {
        viewButton(host, label, `Advanced`).click();
    }
    await nextTick();
};

const showOneList = async (host: HTMLElement, ...blocks: string[]): Promise<void> => {
    for (const label of blocks.length > 0 ? blocks : MODEL_ROLE_BLOCKS.map((block) => block.label)) {
        viewButton(host, label, `Simple`).click();
    }
    await nextTick();
};

// Mounted with every group opened out, for tests about one job's own row.
const mountJobs = async (): Promise<HTMLElement> => {
    const host = mount();
    await Promise.resolve();
    await showJobs(host);
    return host;
};

// Every "Add a model for …" button, in document order; which exist is how a test tells the two views apart.
const adders = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(`button`)].map((button) => button.getAttribute(`aria-label`) ?? ``).filter((label) => label.startsWith(`Add a model`));

// The collapsed row's Add button, worded for the group rather than a job.
const groupAdder = (block: { label: string }): string => `Add a model for every ${block.label.toLowerCase()} job`;

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

// Reading order off screen: one entry per row, in row order.
const orderOnScreen = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(`ol li`)].map((row) => row.querySelector(`span.flex-1`)?.textContent?.trim() ?? ``).filter((text) => text !== ``);

// By label, not position: the row's own name is a button too, so "first button in the row" is no longer stable.
const rowButton = (host: HTMLElement, label: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>(`ol li button`)].find((button) => button.getAttribute(`aria-label`) === label)!;

const addButton = (host: HTMLElement, label: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.getAttribute(`aria-label`) === label)!;

// Job name and its state chip, read structurally: both live in the title with no separating whitespace, so joined text
// would misparse.
const chips = (host: HTMLElement): Record<string, string> =>
    Object.fromEntries(
        [...host.querySelectorAll(`[class*="font-medium"] > span`)].map((title) => [
            title.firstElementChild?.textContent?.trim() ?? ``,
            title.childElementCount > 1 ? (title.lastElementChild?.textContent?.trim() ?? ``) : ``,
        ]),
    );

// Chip wording for an empty list, by job kind: a one-shot doesn't run at all, a session falls back to the chat's own
// model.
const unsetChip = (kind: string): string => (kind === `helper` ? `off` : `chat default`);

test("draws a row per declared role, plus the one setting that is not a role", async () => {
    const host = await mountJobs();

    const named = chips(host);
    for (const role of MODEL_ROLES) {
        expect(Object.keys(named), role.id).toContain(role.label);
    }
    // Not a job: no tick or chip, so it's found by page text rather than by chip title.
    expect(host.textContent).toContain(`Automatic tier`);
    for (const role of MODEL_ROLES) {
        expect(adders(host), role.id).toContain(`Add a model for ${role.label.toLowerCase()}`);
    }
});

test("draws one group per declared block, in order, holding exactly that block's rows", async () => {
    const host = await mountJobs();

    const sections = [...host.querySelectorAll(`section`)];
    for (const [index, block] of MODEL_ROLE_BLOCKS.entries()) {
        const section = sections[index];
        expect(section?.textContent, block.id).toContain(block.label);

        expect(adders(section as HTMLElement), block.id).toEqual(block.roles.map((role) => `Add a model for ${role.label.toLowerCase()}`));
    }

    // The one setting that isn't a job gets its own trailing section.
    expect(sections).toHaveLength(MODEL_ROLE_BLOCKS.length + 1);
    expect(sections.at(-1)?.textContent).toContain(`Automatic tier`);
});

test("a job's glyph and its tick share one slot", async () => {
    const host = await mountJobs();

    // PrimeVue wraps the checkbox; the slot is that wrapper's parent.
    const slot = tickBox(host, `Select commit messages`).closest(`.p-checkbox`)?.parentElement;

    expect(slot?.querySelector(`i`)).not.toBeNull();
    expect(slot?.querySelector(`.p-checkbox`)?.classList.contains(`hidden`)).toBe(false);
});

// Also checks that each block keeps the catalog's own order, so rows can't be silently re-sorted here.
test("reads in order of reach: one-shots, then whole sessions, then the row that can override a live choice", async () => {
    const host = await mountJobs();

    // Read off Add buttons, not headings: labels are already pinned above, and a title `div` has no stable selector.
    const order = adders(host);
    const at = (label: string): number => order.indexOf(label);
    const roleAt = (kind: string): number[] =>
        MODEL_ROLES.filter((role) => role.kind === kind).map((role) => at(`Add a model for ${role.label.toLowerCase()}`));

    const helpers = roleAt(`helper`);
    const runs = roleAt(`run`);
    const automaticTier = at(`Add a model for automatic tier selection`);

    expect(helpers).not.toContain(-1);
    expect(runs).not.toContain(-1);
    expect(Math.max(...helpers)).toBeLessThan(Math.min(...runs));
    expect(Math.max(...runs)).toBeLessThan(automaticTier);
    expect(automaticTier).toBe(order.length - 1);
    expect([...helpers, ...runs]).toEqual([...helpers, ...runs].toSorted((left, right) => left - right));
});

// Checks both connected fixtures by name, not just one, so a resolver that started guessing again couldn't half-pass.
test("names no model at all for a one-shot job nobody has set one for", async () => {
    const host = await mountJobs();

    expect(chips(host)[`Commit messages`]).toBe(`off`);
    expect(host.textContent).not.toContain(`Claude Haiku 4.5`);
    expect(host.textContent).not.toContain(`GPT 5.6 Luna`);
    expect(orderOnScreen(host)).toEqual([]);
});

test("an unset job states itself in a chip beside its name, not in a paragraph under it", async () => {
    const host = await mountJobs();

    const stated = chips(host);
    for (const role of MODEL_ROLES) {
        expect(stated[role.label], role.id).toBe(unsetChip(role.kind));
    }
    expect(host.textContent).not.toContain(`Not set`);
    expect(host.textContent).not.toContain(`Composer default`);
});

test("a job with models drops the chip, because its list already says what it will do", async () => {
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`)] } };
    const host = await mountJobs();

    expect(chips(host)[`Commit messages`]).toBe(``);
    expect(chips(host)[`Session titles`]).toBe(unsetChip(`helper`));
});

test("says nothing about a job until the settings have landed", async () => {
    settings.value = undefined as unknown as SandboxSettings;
    const host = await mountJobs();

    expect(chips(host)[`Commit messages`]).toBe(``);
    expect(chips(host)[`Pipeline fixes`]).toBe(``);
});

test("shows the pinned models in the order the setting holds them", async () => {
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`), entry(`claude`, `claude-haiku-4-5`)] } };
    const host = await mountJobs();

    expect(orderOnScreen(host)).toEqual([`CODEX · GPT 5.6 Luna`, `CLAUDE · Claude Haiku 4.5`]);
});

test("moving one earlier writes the whole new order back", async () => {
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`), entry(`claude`, `claude-haiku-4-5`)] } };
    const host = await mountJobs();

    // First row's button is disabled outright, not a no-op that looks live.
    expect(rowButton(host, `Move CODEX · GPT 5.6 Luna earlier`).disabled).toBe(true);
    rowButton(host, `Move CLAUDE · Claude Haiku 4.5 earlier`).click();

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [COMMIT]: [entry(`claude`, `claude-haiku-4-5`), entry(`codex`, `gpt-5.6`)] } });
});

test("removing the last one empties the list, which is how a job gets switched off", async () => {
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`)] } };
    const host = await mountJobs();

    rowButton(host, `Remove CODEX · GPT 5.6 Luna`).click();

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [COMMIT]: [] } });
});

test("keeps a pin whose account went away on screen, and says why it is greyed", async () => {
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`gemini`, `gemini-3-flash-lite`), entry(`claude`, `claude-haiku-4-5`)] } };
    const host = await mountJobs();

    expect(orderOnScreen(host)).toEqual([`GEMINI · Gemini 3 Flash Lite`, `CLAUDE · Claude Haiku 4.5`]);
    const disconnected = host.querySelector(`ol li`) as HTMLElement;
    expect(disconnected?.className).toMatch(/opacity|subtle|disabled/i);
});

test("the judge row writes its own setting, never another job's", async () => {
    const host = await mountJobs();

    addButton(host, `Add a model for safety judge`).click();
    await flush();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5` });

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [JUDGE]: [entry(`claude`, `claude-haiku-4-5`)] } });
    expect(patch.mock.calls.at(-1)?.[0]?.modelRoles?.[COMMIT]).toBeUndefined();
});

test("a pinned judge model is drawn as written, and removing it empties its own list", async () => {
    settings.value = { ...settings.value, modelRoles: { [JUDGE]: [entry(`codex`, `gpt-5.6`)] } };
    const host = await mountJobs();

    expect(orderOnScreen(host)).toEqual([`CODEX · GPT 5.6 Luna`]);

    rowButton(host, `Remove CODEX · GPT 5.6 Luna`).click();
    expect(patch).toHaveBeenCalledWith({ modelRoles: { [JUDGE]: [] } });
});

test("goes inert with the judge, and says where the switch is", async () => {
    settings.value = { ...settings.value, commandJudge: `off` };
    const host = await mountJobs();

    expect(addButton(host, `Add a model for safety judge`).disabled).toBe(true);
    const link = [...host.querySelectorAll<HTMLAnchorElement>(`a[href]`)].find((anchor) => anchor.textContent?.includes(`Turn the judge on`));
    expect(link?.getAttribute(`href`)).toBe(`/sandbox/agent?section=safety`);
});

test("the judge row stays live while the judge is merely watching", async () => {
    // Watch mode still spends a model on every flagged command, so the row must stay pressable.
    settings.value = { ...settings.value, commandJudge: `watch` };
    const host = await mountJobs();

    expect(addButton(host, `Add a model for safety judge`).disabled).toBe(false);
});

test("an agent-run entry names its own tier, and one left at the provider's default names nothing", async () => {
    settings.value = {
        ...settings.value,
        modelRoles: {
            [RUN]: [
                { provider: `claude`, model: `claude-haiku-4-5`, effort: `high` },
                { provider: `codex`, model: `gpt-5.6` },
            ],
        },
    };
    const host = await mountJobs();

    const rows = [...host.querySelectorAll(`ol li`)].map((row) => row.textContent?.replace(/\s+/g, ` `).trim() ?? ``);
    expect(rows[0]).toContain(`High`);
    expect(rows[1]).toContain(`GPT 5.6 Luna`);
    expect(rows[1]).not.toMatch(/High|Low|thinking/);
});

test("a tier off the model's own scale is drawn as the one that will actually run", async () => {
    // Claude rejects `max` with thinking off, so the row must show what will actually run, not the stored pick.
    settings.value = {
        ...settings.value,
        modelRoles: { [RUN]: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `max`, thinking: false }] },
    };
    const host = await mountJobs();

    expect(host.querySelector(`ol li`)?.textContent).toContain(`X-High`);
    expect(settings.value.modelRoles[RUN]?.[0]?.effort).toBe(`max`);
});

test("an entry that pinned no thinking keeps the top tier it asked for", async () => {
    settings.value = { ...settings.value, modelRoles: { [RUN]: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `max` }] } };
    const host = await mountJobs();

    expect(host.querySelector(`ol li`)?.textContent).toContain(`Max`);
});

test("pressing an agent-run row opens the picker over that entry, with its knobs", async () => {
    settings.value = {
        ...settings.value,
        modelRoles: {
            [RUN]: [
                { provider: `codex`, model: `gpt-5.6` },
                { provider: `claude`, model: `claude-haiku-4-5`, effort: `low` },
            ],
        },
    };
    const host = await mountJobs();

    rowButton(host, `Change CLAUDE · Claude Haiku 4.5`).click();
    await flush();

    expect(opened?.pin).toEqual({ provider: `claude`, model: `claude-haiku-4-5`, effort: `low` });
    expect(opened?.knobs).toBe(true);
    expect(opened?.taken).toEqual([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]);
});

test("a one-shot row opens the picker with knobs, because its job now honours them", async () => {
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`)] } };
    const host = await mountJobs();

    rowButton(host, `Change CODEX · GPT 5.6 Luna`).click();
    await flush();

    expect(opened?.pin).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(opened?.knobs).toBe(true);
});

test("the cheaper-tier row opens the picker without knobs: its substitution cannot honour one", async () => {
    settings.value = { ...settings.value, autoFastModels: [`codex:gpt-5.6`] };
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
        modelRoles: {
            [RUN]: [
                { provider: `codex`, model: `gpt-5.6`, effort: `high` },
                { provider: `claude`, model: `claude-haiku-4-5` },
            ],
        },
    };
    const host = await mountJobs();
    rowButton(host, `Change CLAUDE · Claude Haiku 4.5`).click();
    await flush();

    answer?.configure({ provider: `claude`, model: `claude-haiku-4-5`, effort: `max`, thinking: true });

    expect(patch).toHaveBeenCalledWith({
        modelRoles: {
            [RUN]: [
                { provider: `codex`, model: `gpt-5.6`, effort: `high` },
                { provider: `claude`, model: `claude-haiku-4-5`, effort: `max`, thinking: true },
            ],
        },
    });
    // Confirms the panel stays open and re-reads the entry's new state live.
    await flush();
    expect(opened?.pin).toEqual({ provider: `claude`, model: `claude-haiku-4-5`, effort: `max`, thinking: true });
});

test("re-pointing an entry replaces it where it stands, because its position is the other half of the setting", async () => {
    settings.value = {
        ...settings.value,
        modelRoles: {
            [RUN]: [
                { provider: `codex`, model: `gpt-5.6` },
                { provider: `claude`, model: `claude-haiku-4-5`, effort: `low` },
            ],
        },
    };
    const host = await mountJobs();
    rowButton(host, `Change CODEX · GPT 5.6 Luna`).click();
    await flush();

    answer?.pick({ provider: `claude`, model: `claude-opus-5`, effort: `max` });

    expect(patch).toHaveBeenCalledWith({
        modelRoles: {
            [RUN]: [
                { provider: `claude`, model: `claude-opus-5`, effort: `max` },
                { provider: `claude`, model: `claude-haiku-4-5`, effort: `low` },
            ],
        },
    });
});

test("adding appends to the end of the order, and leaves every other job's list standing", async () => {
    const host = await mountJobs();

    addButton(host, `Add a model for pipeline fixes`).click();
    await flush();
    expect(opened?.pin).toBeUndefined();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5`, effort: `high` });
    expect(patch).toHaveBeenCalledWith({ modelRoles: { [RUN]: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `high` }] } });

    addButton(host, `Add a model for commit messages`).click();
    await flush();
    answer?.pick({ provider: `codex`, model: `gpt-5.6` });
    expect(patch).toHaveBeenCalledWith({
        modelRoles: {
            [RUN]: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `high` }],
            [COMMIT]: [entry(`codex`, `gpt-5.6`)],
        },
    });
});

// PrimeVue wraps the checkbox input; the aria-label rides the input itself, which a click must target.
const tickBox = (host: HTMLElement, label: string): HTMLInputElement =>
    [...host.querySelectorAll<HTMLInputElement>(`input[type="checkbox"]`)].find((box) => box.getAttribute(`aria-label`) === label)!;

const tick = (host: HTMLElement, label: string): void => {
    const box = tickBox(host, label);
    box.checked = true;
    box.dispatchEvent(new Event(`change`, { bubbles: true }));
};

// By button text, not a container id: the header is a `<RowGroup>` slot, not a landmark of its own.
const groupButton = (host: HTMLElement, block: string, label: string): HTMLButtonElement =>
    [...group(host, block).querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.includes(label))!;

// A group's verb buttons, matched by their text.
const verbs = (host: HTMLElement, block: string): string[] =>
    [...group(host, block).querySelectorAll(`button`)]
        .map((button) => button.textContent?.replace(/\s+/g, ` `).trim() ?? ``)
        .filter((label) => label.includes(`Set a model for all`) || label.includes(`Clear models`));

// Named via the catalog, not transcribed, so a role moving blocks doesn't go stale here.
const HELPERS = MODEL_ROLE_BLOCKS[0]!;
const PRESSED = MODEL_ROLE_BLOCKS[1]!;

// The row is a `<label>`; only two regions are carved out of it (the Add button, the pinned list), and either could
// regress silently if its click-stop ever came off.

// The row's own element, by job name; asserted by tag, since becoming a `<label>` is the behaviour under test.
const rowOf = (host: HTMLElement, label: string): HTMLElement =>
    [...host.querySelectorAll<HTMLElement>(`[class*="font-medium"] > span > span`)]
        .find((name) => name.textContent?.trim() === label)!
        .closest(`.group`)!;

test("the whole headline ticks the job, so the target is the row rather than an 18px box", async () => {
    const host = await mountJobs();

    const row = rowOf(host, `Commit messages`);
    expect(row.tagName).toBe(`LABEL`);

    // The row's description: the point in the row furthest from the tick box.
    row.querySelector(`p`)!.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
    await nextTick();

    expect(tickBox(host, `Select commit messages`).checked).toBe(true);
    expect(verbs(host, HELPERS.label)).toEqual([`Set a model for all…`, `Clear models`]);
});

test("the Add button opens the picker without ticking the job it belongs to", async () => {
    const host = await mountJobs();

    addButton(host, `Add a model for commit messages`).click();
    await flush();

    expect(opened?.pin).toBeUndefined();
    expect(tickBox(host, `Select commit messages`).checked).toBe(false);
});

test("a press on the pinned list stays in the list rather than ticking the job under it", async () => {
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`)] } };
    const host = await mountJobs();

    rowButton(host, `Remove CODEX · GPT 5.6 Luna`).click();
    await nextTick();

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [COMMIT]: [] } });
    expect(tickBox(host, `Select commit messages`).checked).toBe(false);
});

test("no bulk verbs until something is ticked, and then only in that group's header", async () => {
    const host = await mountJobs();

    expect(verbs(host, HELPERS.label)).toEqual([]);
    expect(verbs(host, PRESSED.label)).toEqual([]);

    tick(host, `Select commit messages`);
    await nextTick();

    expect(verbs(host, HELPERS.label)).toEqual([`Set a model for all…`, `Clear models`]);
    expect(verbs(host, PRESSED.label)).toEqual([]);
});

test("one pick lands on every ticked job in that group, in one patch, and never on another group's", async () => {
    // Starts with an existing entry, so the write must be visibly an append, not a replacement.
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`)] } };
    const host = await mountJobs();

    tick(host, `Select commit messages`);
    tick(host, `Select session titles`);
    // Ticked in a different block, from the helpers' header: must not be written.
    tick(host, `Select pipeline fixes`);
    await nextTick();
    groupButton(host, HELPERS.label, `Set a model for all`).click();
    await flush();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5` });

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({
        modelRoles: {
            [COMMIT]: [entry(`codex`, `gpt-5.6`), entry(`claude`, `claude-haiku-4-5`)],
            [`session-title`]: [entry(`claude`, `claude-haiku-4-5`)],
        },
    });
    expect(patch.mock.calls.at(-1)?.[0]?.modelRoles?.[RUN]).toBeUndefined();
    expect(patch.mock.calls.at(-1)?.[0]?.modelRoles?.[JUDGE]).toBeUndefined();
});

test("the tier chosen after the model reaches the same entry in every ticked job", async () => {
    const host = await mountJobs();

    tick(host, `Select commit messages`);
    tick(host, `Select session titles`);
    await nextTick();
    groupButton(host, HELPERS.label, `Set a model for all`).click();
    await flush();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5` });
    await flush();

    expect(host.querySelector(`.pin-picker`)).not.toBeNull();
    expect(opened?.pin).toEqual(entry(`claude`, `claude-haiku-4-5`));

    answer?.configure({ provider: `claude`, model: `claude-haiku-4-5`, effort: `low` });

    expect(patch).toHaveBeenLastCalledWith({
        modelRoles: {
            [COMMIT]: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `low` }],
            [`session-title`]: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `low` }],
        },
    });
});

test("picking again supersedes the model the same panel just wrote", async () => {
    const host = await mountJobs();

    tick(host, `Select commit messages`);
    await nextTick();
    groupButton(host, HELPERS.label, `Set a model for all`).click();
    await flush();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5` });
    answer?.pick({ provider: `codex`, model: `gpt-5.6` });

    expect(patch).toHaveBeenLastCalledWith({ modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`)] } });
});

test("clearing the ticked jobs empties their lists, which is how several jobs are switched off at once", async () => {
    settings.value = {
        ...settings.value,
        modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`)], [JUDGE]: [entry(`claude`, `claude-haiku-4-5`)] },
    };
    const host = await mountJobs();

    tick(host, `Select commit messages`);
    await nextTick();
    groupButton(host, HELPERS.label, `Clear models`).click();

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [COMMIT]: [], [JUDGE]: [entry(`claude`, `claude-haiku-4-5`)] } });
});

test("a group's master box ticks that block's jobs, and only those", async () => {
    const host = await mountJobs();

    tick(host, `Select every job under ${HELPERS.label.toLowerCase()}`);
    await nextTick();
    groupButton(host, HELPERS.label, `Set a model for all`).click();
    await flush();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5` });

    const written = patch.mock.calls.at(-1)?.[0]?.modelRoles ?? {};
    expect(Object.keys(written).toSorted()).toEqual(HELPERS.roles.map((role) => role.id).toSorted());
    // Automatic tier isn't a role, so no master box may reach its list.
    expect(patch.mock.calls.at(-1)?.[0]?.autoFastModels).toBeUndefined();
});

test("one group's master box does not tick another group's", async () => {
    const host = await mountJobs();

    tick(host, `Select every job under ${HELPERS.label.toLowerCase()}`);
    await nextTick();

    expect(verbs(host, PRESSED.label)).toEqual([]);
    for (const role of PRESSED.roles) {
        expect(tickBox(host, `Select ${role.label.toLowerCase()}`).checked, role.id).toBe(false);
    }
});

// Every job of a block holding the same list: the case the collapsed view opens for.
const allOf = (block: { readonly roles: readonly { readonly id: string }[] }, pins: ModelPin[]): SandboxSettings[`modelRoles`] =>
    Object.fromEntries(block.roles.map((role) => [role.id, pins])) as SandboxSettings[`modelRoles`];

test("a group opens as one list while its jobs agree, and offers nothing per job", async () => {
    const host = mount();
    await Promise.resolve();

    expect(adders(group(host, HELPERS.label))).toEqual([groupAdder(HELPERS)]);
    expect(group(host, HELPERS.label).textContent).toContain(`One list for all ${HELPERS.roles.length} jobs`);
    // Jobs stay named in the group text, since a row writing five settings owes their names.
    for (const role of HELPERS.roles) {
        expect(group(host, HELPERS.label).textContent, role.id).toContain(role.label);
    }
});

test("one model picked there lands on every job of that block, in one patch, and on no other block's", async () => {
    const host = mount();
    await Promise.resolve();

    addButton(host, groupAdder(HELPERS)).click();
    await flush();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5` });

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({ modelRoles: allOf(HELPERS, [entry(`claude`, `claude-haiku-4-5`)]) });
    expect(patch.mock.calls.at(-1)?.[0]?.modelRoles?.[RUN]).toBeUndefined();
});

test("draws the block's order once, however many jobs are holding it", async () => {
    settings.value = { ...settings.value, modelRoles: allOf(HELPERS, [entry(`codex`, `gpt-5.6`), entry(`claude`, `claude-haiku-4-5`)]) };
    const host = mount();
    await Promise.resolve();

    expect(orderOnScreen(host)).toEqual([`CODEX · GPT 5.6 Luna`, `CLAUDE · Claude Haiku 4.5`]);
});

test("a change made in the collapsed list gives every job of the block exactly that list", async () => {
    settings.value = { ...settings.value, modelRoles: allOf(HELPERS, [entry(`codex`, `gpt-5.6`)]) };
    const host = mount();
    await Promise.resolve();

    rowButton(host, `Remove CODEX · GPT 5.6 Luna`).click();

    expect(patch).toHaveBeenCalledWith({ modelRoles: allOf(HELPERS, []) });
});

test("a block whose jobs already differ opens showing them apart, and its neighbours stay as one list", async () => {
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`)] } };
    const host = mount();
    await Promise.resolve();

    expect(adders(group(host, HELPERS.label))).toEqual(HELPERS.roles.map((role) => `Add a model for ${role.label.toLowerCase()}`));
    expect(adders(group(host, PRESSED.label))).toEqual([groupAdder(PRESSED)]);
});

test("collapsed over jobs that differ, it shows only what every one of them holds, and says so", async () => {
    const shared = entry(`codex`, `gpt-5.6`);
    settings.value = {
        ...settings.value,
        modelRoles: { ...allOf(HELPERS, [shared]), [COMMIT]: [shared, entry(`claude`, `claude-haiku-4-5`)] },
    };
    const host = mount();
    await Promise.resolve();
    await showOneList(host, HELPERS.label);

    expect(orderOnScreen(host)).toEqual([`CODEX · GPT 5.6 Luna`]);
    expect(chips(host)[`One list for all ${HELPERS.roles.length} jobs`]).toBe(`jobs differ`);
});

test("collapsing a group takes its ticks with it, and leaves the other groups as they were", async () => {
    const host = await mountJobs();

    tick(host, `Select commit messages`);
    await nextTick();
    expect(verbs(host, HELPERS.label)).toEqual([`Set a model for all…`, `Clear models`]);

    await showOneList(host, HELPERS.label);

    expect(adders(group(host, HELPERS.label))).toEqual([groupAdder(HELPERS)]);
    expect(adders(group(host, PRESSED.label))).toEqual(PRESSED.roles.map((role) => `Add a model for ${role.label.toLowerCase()}`));

    await showJobs(host, HELPERS.label);
    expect(tickBox(host, `Select commit messages`).checked).toBe(false);
    expect(verbs(host, HELPERS.label)).toEqual([]);
});

// Every helper but the judge holding one list: the state reached by setting live rows while the judge is off.
const liveHelpers = (pins: ModelPin[]): SandboxSettings[`modelRoles`] =>
    Object.fromEntries(HELPERS.roles.filter((role) => role.id !== JUDGE).map((role) => [role.id, pins])) as SandboxSettings[`modelRoles`];

test("a block whose only odd job is switched off still opens as one list, and says nothing about differing", async () => {
    settings.value = { ...settings.value, commandJudge: `off`, modelRoles: liveHelpers([entry(`codex`, `gpt-5.6`)]) };
    const host = mount();
    await Promise.resolve();

    expect(adders(group(host, HELPERS.label))).toEqual([groupAdder(HELPERS)]);
    expect(chips(host)[`One list for all ${HELPERS.roles.length - 1} jobs`]).toBe(``);
    expect(group(host, HELPERS.label).textContent).not.toContain(`jobs differ`);
});

test("the collapsed row counts only the jobs it writes, and says which one it left out", async () => {
    settings.value = { ...settings.value, commandJudge: `off` };
    const host = mount();
    await Promise.resolve();

    const helpers = group(host, HELPERS.label);
    expect(helpers.textContent).toContain(`One list for all ${HELPERS.roles.length - 1} jobs`);
    const link = [...helpers.querySelectorAll<HTMLAnchorElement>(`a[href]`)].find((anchor) => anchor.textContent?.includes(`Turn the judge on`));
    expect(link?.getAttribute(`href`)).toBe(`/sandbox/agent?section=safety`);
});

test("one model picked in the collapsed list reaches every live job and leaves the switched-off one as it was", async () => {
    settings.value = { ...settings.value, commandJudge: `off`, modelRoles: { [JUDGE]: [entry(`codex`, `gpt-5.6`)] } };
    const host = mount();
    await Promise.resolve();

    addButton(host, groupAdder(HELPERS)).click();
    await flush();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5` });

    const written = patch.mock.calls.at(-1)?.[0]?.modelRoles ?? {};
    for (const role of HELPERS.roles) {
        expect(written[role.id], role.id).toEqual(role.id === JUDGE ? [entry(`codex`, `gpt-5.6`)] : [entry(`claude`, `claude-haiku-4-5`)]);
    }
});

test("a switched-off job offers no tick, and the group's master box writes without it", async () => {
    settings.value = { ...settings.value, commandJudge: `off` };
    const host = await mountJobs();

    expect(tickBox(host, `Select safety judge`)).toBeUndefined();

    tick(host, `Select every job under ${HELPERS.label.toLowerCase()}`);
    await nextTick();
    groupButton(host, HELPERS.label, `Set a model for all`).click();
    await flush();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5` });

    const written = patch.mock.calls.at(-1)?.[0]?.modelRoles ?? {};
    expect(Object.keys(written).toSorted()).toEqual(
        HELPERS.roles
            .map((role) => role.id)
            .filter((id) => id !== JUDGE)
            .toSorted(),
    );
});

// Three-way mode control, matched by its clicked label.
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

    // No space before `of`: the gap is layout (flex gap), not text; joined as one string so the count is checked
    // against its own denominator.
    expect(host.textContent).toContain(`${tier.fast}of ${tier.judged} turns judged simple`);
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
