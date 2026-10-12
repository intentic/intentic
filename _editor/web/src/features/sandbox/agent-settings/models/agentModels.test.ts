// Pins that the page draws every setup with the jobs on it, that a setup's edit lands on that setup alone, and that a
// job dragged or picked onto another setup moves that job alone. Mounted, since what's tested is the click-through round
// trip.
import "@intentic/testing/dom";
import {
    humanizeModelId,
    MODEL_ROLES,
    type ModelPin,
    type SandboxSettings,
    SandboxSettingsSchema,
} from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { IconStub } from "@intentic/ui/testing";
import * as uiOriginal from "@intentic/ui";

// useDevice reads window.matchMedia at import; environment.ts reads window.env.

// Representative jobs: an ordinary one-shot (`commit-message`), one with an external switch (`safety-judge`), the one
// with a second setting (`model-router`), and a session (`pipeline-fix`).
const COMMIT = `commit-message` as const;
const JUDGE = `safety-judge` as const;
const ROUTER = `model-router` as const;
const RUN = `pipeline-fix` as const;

const entry = (provider: string, model: string, rest: Record<string, unknown> = {}): ModelPin => ({ provider, model, ...rest }) as ModelPin;

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = jest.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

jest.mock(`../../overview/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({
        settings,
        patch,
        dropped: ref(undefined),
        error: ref(undefined),
        isLoading: ref(false),
        save: { mutate: patch, isPending: ref(false), error: ref(null) },
    }),
}));

// Two connected accounts, one not, since which one a click spends is exactly what these rows test.
const CATALOGS: Record<string, readonly { value: string; label: string }[]> = {
    codex: [{ value: `gpt-5.6`, label: `GPT 5.6 Luna` }],
    claude: [{ value: `claude-haiku-4-5`, label: `Claude Haiku 4.5` }],
    gemini: [{ value: `gemini-3-flash-lite`, label: `Gemini 3 Flash Lite` }],
};
const connected = ref<readonly string[]>([`codex`, `claude`]);

jest.mock(`../../../chat/session/access`, () => ({ providerReady: (provider: string) => connected.value.includes(provider) }));
// Empty `providerModels` unless a test fills it: puts every model on the static effort scale, the state every fixture
// here assumes, and leaves the presets nothing to suggest from.
const providerModels = ref<Record<string, readonly { value: string; label: string; helperOnly?: string }[]>>({});
jest.mock(`../../../chat/accounts/providerCatalog`, () => ({
    endpointProviders: ref([]),
    providerModels,
    demandCatalog: () => undefined,
    modelOptionsFor: (provider: string) => CATALOGS[provider] ?? [],
    modelLabelFor: (provider: string, model: string) => CATALOGS[provider]?.find((option) => option.value === model)?.label ?? humanizeModelId(model),
    providerDisplayLabel: (provider: string) => provider.toUpperCase(),
    // <ProviderLogo> names it; bun links an ESM import against exactly what this factory returns.
    providerGlyph: () => `cpu`,
}));

// Stubbed rather than mounted: what's under test is the wiring between a row and its list, not the real catalog. Props
// are handed over live, so a test can watch an entry change under the open panel.
let opened:
    | {
          readonly open?: boolean;
          readonly header?: string;
          readonly pin?: unknown;
          readonly current?: unknown;
          readonly knobs?: boolean;
          readonly taken?: unknown;
          readonly helperJobs?: boolean;
      }
    | undefined;
let answer: { pick: (pin: unknown) => void; configure: (pin: unknown) => void } | undefined;
jest.mock(`./ModelPinPicker.vue`, () => ({
    // `__esModule` so the SFC interop reads `.default` the way it would off the real component.
    __esModule: true,
    default: defineComponent({
        props: { open: Boolean, anchor: Object, header: String, pin: Object, current: Object, knobs: Boolean, taken: Array, helperJobs: Boolean },
        emits: [`update:open`, `pick`, `configure`],
        setup(props, { emit }) {
            opened = props;
            answer = { pick: (pin) => emit(`pick`, pin), configure: (pin) => emit(`configure`, pin) };
            return () => h(`div`, { class: `pin-picker` });
        },
    }),
}));

// The guidance editor, stubbed the same way and for the same reason as the picker: what is under test is what this page
// hands it and what it does with a save, not the document surface, which is `@intentic/ui`'s own.
let doc: { readonly modelValue?: string; readonly stored?: string; readonly maxChars?: number } | undefined;
let saveDoc: ((text: string) => void) | undefined;
// The job panel's frame measures its anchor and shuts on a zero-size one, which every element in this DOM is; what is
// under test is the panel's content and what its choices write, so the frame just draws its slot while open.
jest.mock(`@intentic/ui`, () => ({
    ...uiOriginal,
    ResponsiveOverlay: defineComponent({
        props: { modelValue: Boolean, anchor: Object, header: String, panelClass: String, side: String },
        emits: [`update:modelValue`],
        setup(props, { slots }) {
            return () => (props.modelValue ? h(`div`, { class: `job-panel` }, slots[`default`]?.()) : null);
        },
    }),
    MarkdownDocument: defineComponent({
        props: { modelValue: String, stored: String, maxChars: Number, placeholder: String, label: String, editable: Boolean, saving: Boolean },
        emits: [`update:modelValue`, `save`],
        setup(props, { emit }) {
            doc = props;
            saveDoc = (text: string) => emit(`save`, text);
            return () => h(`div`, { class: `guidance-doc` }, props.placeholder ?? ``);
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

const mountPage = async (): Promise<HTMLElement> => {
    const host = mount();
    await flush();
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    settings.value = SandboxSettingsSchema.parse({});
    connected.value = [`codex`, `claude`];
    providerModels.value = {};
    opened = undefined;
    answer = undefined;
    doc = undefined;
    saveDoc = undefined;
    patch.mockClear();
});

const labelOf = (role: string): string => MODEL_ROLES.find((spec) => spec.id === role)!.label;
const suggestedOn = (setup: string): string[] => MODEL_ROLES.filter((role) => role.setup === setup).map((role) => role.label);
// Every job on the preset suggested for it: the shape most tests start from.
const SUGGESTED_PLACES = Object.fromEntries(MODEL_ROLES.map((role) => [role.id, role.setup]));
const tray = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>(`[data-setup-drop="unassigned"]`)!;

// Each setup card, top to bottom, by its name; the jobs on one; and the page as names to jobs.
const cards = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`section[aria-label]:has(> header)`)];
const nameOf = (card: HTMLElement): string => card.getAttribute(`aria-label`) ?? ``;
const card = (host: HTMLElement, name: string): HTMLElement => cards(host).find((candidate) => nameOf(candidate) === name)!;
const jobsOf = (scope: HTMLElement): string[] =>
    [...scope.querySelectorAll(`li[id^="model-job-"] button > span:first-of-type`)].map((label) => label.textContent?.trim() ?? ``);
const layoutOf = (host: HTMLElement): Record<string, string[]> => Object.fromEntries(cards(host).map((each) => [nameOf(each), jobsOf(each)]));

// Reading order off screen: one entry per model, in list order.
const orderOn = (scope: HTMLElement): string[] =>
    [...scope.querySelectorAll(`ol li`)].map((row) => row.querySelector(`span.flex-1`)?.textContent?.trim() ?? ``).filter((text) => text !== ``);

const button = (scope: HTMLElement, label: string): HTMLButtonElement =>
    [...scope.querySelectorAll<HTMLButtonElement>(`button`)].find((candidate) => candidate.getAttribute(`aria-label`) === label)!;
const pressed = (scope: HTMLElement, text: string): HTMLButtonElement =>
    [...scope.querySelectorAll<HTMLButtonElement>(`button`)].find((candidate) => candidate.textContent?.trim() === text)!;
const chip = (host: HTMLElement, job: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>(`li[id^="model-job-"] button`)].find((candidate) => candidate.querySelector(`span`)?.textContent?.trim() === job)!;

// The open job panel's choices, by their first line, and which one is ticked.
const choices = (): string[] => [...document.querySelectorAll(`.job-panel [role="radio"] span span:first-child`)].map((line) => line.textContent?.trim() ?? ``);
const ticked = (): string | undefined => document.querySelector(`.job-panel [role="radio"][aria-checked="true"] span span:first-child`)?.textContent?.trim();
const choose = async (label: string): Promise<void> => {
    [...document.querySelectorAll<HTMLButtonElement>(`.job-panel [role="radio"]`)].find((choice) => choice.querySelector(`span span`)?.textContent?.trim() === label)!.click();
    await flush();
};
const openJob = async (host: HTMLElement, job: string): Promise<void> => {
    chip(host, job).click();
    await flush();
};

// A mouse drag from a chip to a point over a drop zone. jsdom has no layout, so the hit test is pointed at the zone.
const dragTo = async (host: HTMLElement, job: string, zone: () => Element): Promise<void> => {
    const from = chip(host, job);
    const original = document.elementFromPoint;
    from.dispatchEvent(new PointerEvent(`pointerdown`, { bubbles: true, button: 0, pointerType: `mouse`, clientX: 0, clientY: 0 }));
    document.elementFromPoint = () => zone();
    try {
        window.dispatchEvent(new PointerEvent(`pointermove`, { clientX: 40, clientY: 40 }));
        await flush();
        window.dispatchEvent(new PointerEvent(`pointermove`, { clientX: 60, clientY: 60 }));
        await flush();
        window.dispatchEvent(new PointerEvent(`pointerup`, { clientX: 60, clientY: 60 }));
        // A real drag's pointerup also clicks the chip it started from; the page must not open its panel for it.
        from.click();
        await flush();
    } finally {
        document.elementFromPoint = original;
    }
};
const zoneOf = (host: HTMLElement, name: string) => () => card(host, name).querySelector(`[data-setup-drop]`)!;

const haiku = entry(`claude`, `claude-haiku-4-5`);
const luna = entry(`codex`, `gpt-5.6`);

/* THE SETUPS ON THE PAGE */

test("a fresh sandbox lists every job as not assigned, beside Low, Medium and High with nothing on them", async () => {
    const host = await mountPage();

    expect(jobsOf(tray(host))).toEqual(MODEL_ROLES.map((role) => role.label));
    expect(layoutOf(host)).toEqual({ Low: [], Medium: [], High: [] });
    // Nothing connected offers a model yet, so each says how it fills.
    expect(card(host, `Low`).textContent).toContain(`Connect an account and this fills itself in.`);
});

test("one press puts every job on the setup suggested for it, and the list of jobs goes away", async () => {
    const host = await mountPage();

    pressed(host, `Place on suggested setups`).click();
    await flush();

    expect(patch).toHaveBeenCalledWith({ roleSetups: SUGGESTED_PLACES });
    expect(layoutOf(host)).toEqual({ Low: suggestedOn(`low`), Medium: suggestedOn(`medium`), High: suggestedOn(`high`) });
    expect(host.querySelector(`[data-setup-drop="unassigned"]`)).toBeNull();
});

test("a preset is worked out from the connected accounts' catalogs, and says so", async () => {
    providerModels.value = {
        claude: [
            { value: `claude-haiku-4-5`, label: `Claude Haiku 4.5` },
            { value: `claude-opus-5`, label: `Claude Opus 5` },
        ],
        codex: [{ value: `gpt-5.6-luna`, label: `GPT 5.6 Luna` }],
        // Not connected: offers nothing.
        gemini: [{ value: `gemini-3-flash-lite`, label: `Gemini 3 Flash Lite` }],
    };
    const host = await mountPage();

    expect(orderOn(card(host, `Low`))).toEqual([`CLAUDE · Claude Haiku 4.5`, `CODEX · GPT 5.6 Luna`]);
    expect(orderOn(card(host, `High`))).toEqual([`CLAUDE · Claude Opus 5`]);
    expect(card(host, `Low`).textContent).toContain(`Suggested`);
});

test("a setup of the owner's comes after the presets, with the jobs put on it", async () => {
    settings.value = { ...settings.value, modelSetups: [{ id: `setup-1`, name: `Reviews`, pins: [luna] }], roleSetups: { [COMMIT]: `setup-1` } };
    const host = await mountPage();

    expect(Object.keys(layoutOf(host))).toEqual([`Low`, `Medium`, `High`, `Reviews`]);
    expect(layoutOf(host)[`Reviews`]).toEqual([labelOf(COMMIT)]);
    expect(jobsOf(tray(host))).not.toContain(labelOf(COMMIT));
});

/* EDITING A SETUP EDITS IT FOR EVERY JOB ON IT */

test("adding to a suggested preset writes it whole, from then on its own list", async () => {
    providerModels.value = { claude: [{ value: `claude-haiku-4-5`, label: `Claude Haiku 4.5` }] };
    const host = await mountPage();

    button(card(host, `Low`), `Add a model to Low`).click();
    await flush();
    expect([opened?.header, opened?.current]).toEqual([`Add a fallback model`, { provider: `claude`, model: `claude-haiku-4-5` }]);
    answer?.pick(luna);

    expect(patch).toHaveBeenCalledWith({ modelSetups: [{ id: `low`, pins: [{ provider: `claude`, model: `claude-haiku-4-5` }, luna] }] });
});

test("reordering a setup writes that setup's list and touches no job", async () => {
    settings.value = { ...settings.value, modelSetups: [{ id: `high`, pins: [luna, haiku] }] };
    const host = await mountPage();

    const high = card(host, `High`);
    expect(button(high, `Move CODEX · GPT 5.6 Luna earlier`).disabled).toBe(true);
    button(high, `Move CLAUDE · Claude Haiku 4.5 earlier`).click();

    expect(patch).toHaveBeenCalledWith({ modelSetups: [{ id: `high`, pins: [haiku, luna] }] });
});

test("keeps a pin whose account went away on screen, and greys it", async () => {
    settings.value = { ...settings.value, modelSetups: [{ id: `low`, pins: [entry(`gemini`, `gemini-3-flash-lite`), haiku] }] };
    const host = await mountPage();

    expect(orderOn(card(host, `Low`))).toEqual([`GEMINI · Gemini 3 Flash Lite`, `CLAUDE · Claude Haiku 4.5`]);
    expect(card(host, `Low`).querySelector(`ol li`)?.className).toMatch(/subtle/);
});

test("an entry names the tier it will run at, and one left at the provider's default names nothing", async () => {
    settings.value = {
        ...settings.value,
        modelSetups: [{ id: `high`, pins: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `max`, thinking: false }, luna] }],
    };
    const host = await mountPage();

    const lines = [...card(host, `High`).querySelectorAll(`ol li`)].map((row) => row.textContent?.replace(/\s+/g, ` `).trim() ?? ``);
    // Claude refuses `max` with thinking off, so the row shows what will actually run, not the stored pick.
    expect(lines[0]).toContain(`X-High`);
    expect(lines[1]).not.toMatch(/High|Low|thinking/);
});

test("a knob moved in the picker lands on that entry alone", async () => {
    settings.value = { ...settings.value, modelSetups: [{ id: `high`, pins: [luna, haiku] }] };
    const host = await mountPage();

    button(card(host, `High`), `Change CLAUDE · Claude Haiku 4.5`).click();
    await flush();
    expect([opened?.pin, opened?.knobs, opened?.taken]).toEqual([haiku, true, [`codex:gpt-5.6`, `claude:claude-haiku-4-5`]]);

    const tuned = { ...haiku, effort: `max`, thinking: true };
    answer?.configure(tuned);

    expect(patch).toHaveBeenCalledWith({ modelSetups: [{ id: `high`, pins: [luna, tuned] }] });
    await flush();
    expect(opened?.pin).toEqual(tuned);
});

test("a model that cannot run a turn is offered only to a setup that feeds nothing but one-shot jobs", async () => {
    settings.value = { ...settings.value, roleSetups: SUGGESTED_PLACES };
    const host = await mountPage();

    button(card(host, `Low`), `Add a model to Low`).click();
    await flush();
    expect(opened?.helperJobs).toBe(true);

    button(card(host, `High`), `Add a model to High`).click();
    await flush();
    expect(opened?.helperJobs).toBe(false);
});

test("a second press on the trigger that opened the picker closes it", async () => {
    const host = await mountPage();
    const add = button(card(host, `Low`), `Add a model to Low`);

    add.click();
    await flush();
    expect(opened?.open).toBe(true);
    add.click();
    await flush();
    expect(opened?.open).toBe(false);
});

/* MAKING, NAMING AND DELETING SETUPS */

test("New setup makes an empty one, named in order, with its name ready to type", async () => {
    const host = await mountPage();

    pressed(host, `New setup`).click();
    await flush();

    expect(patch).toHaveBeenCalledWith({ modelSetups: [{ id: `setup-1`, name: `Setup 1`, pins: [] }] });
    expect(document.activeElement?.getAttribute(`aria-label`)).toBe(`Setup name`);
    expect(cards(host).at(-1)?.textContent).toContain(`Add models, then drag jobs here.`);
});

test("renaming writes the name; a preset keeps saying what it was", async () => {
    const host = await mountPage();

    const high = card(host, `High`);
    // The name is its own rename (<InlineRename>), the same press as the sandbox's name.
    high.querySelector<HTMLButtonElement>(`h3 button`)!.click();
    await flush();
    const field = high.querySelector<HTMLInputElement>(`input`)!;
    field.value = `Heavy`;
    field.dispatchEvent(new Event(`input`));
    field.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter` }));
    await flush();

    expect(patch).toHaveBeenCalledWith({ modelSetups: [{ id: `high`, name: `Heavy` }] });
    expect(card(host, `Heavy`).textContent).toContain(`was High`);
});

test("deleting a setup of the owner's lists its jobs as not assigned again", async () => {
    settings.value = { ...settings.value, modelSetups: [{ id: `setup-1`, name: `Reviews`, pins: [luna] }], roleSetups: { ...SUGGESTED_PLACES, [COMMIT]: `setup-1` } };
    const host = await mountPage();

    button(card(host, `Reviews`), `Delete setup`).click();
    await flush();

    const { [COMMIT]: _gone, ...rest } = SUGGESTED_PLACES;
    expect(patch).toHaveBeenCalledWith({ modelSetups: [], roleSetups: rest });
    expect(jobsOf(tray(host))).toEqual([labelOf(COMMIT)]);
});

test("a preset cannot be deleted, and an edited one can go back to suggested models", async () => {
    settings.value = { ...settings.value, modelSetups: [{ id: `low`, pins: [luna] }] };
    const host = await mountPage();

    expect(button(card(host, `Low`), `Delete setup`)).toBeUndefined();
    button(card(host, `Low`), `Use suggested models`).click();

    expect(patch).toHaveBeenCalledWith({ modelSetups: [] });
});

/* MOVING A JOB, BY DRAG OR FROM ITS PANEL */

test("dragging a job from the list onto a setup places that job alone, and opens nothing", async () => {
    const host = await mountPage();

    await dragTo(host, labelOf(COMMIT), zoneOf(host, `High`));

    expect(patch).toHaveBeenCalledWith({ roleSetups: { [COMMIT]: `high` } });
    expect(layoutOf(host)[`High`]).toEqual([labelOf(COMMIT)]);
    expect(jobsOf(tray(host))).not.toContain(labelOf(COMMIT));
    expect(document.querySelector(`.job-panel`)).toBeNull();
});

test("dragging between setups moves the job, and a drop where it already is writes nothing", async () => {
    settings.value = { ...settings.value, roleSetups: SUGGESTED_PLACES };
    const host = await mountPage();

    await dragTo(host, labelOf(COMMIT), zoneOf(host, `Low`));
    expect(patch).not.toHaveBeenCalled();

    await dragTo(host, labelOf(COMMIT), zoneOf(host, `Medium`));
    expect(patch).toHaveBeenCalledWith({ roleSetups: { ...SUGGESTED_PLACES, [COMMIT]: `medium` } });
});

test("while a job is in flight, the list and a new setup are places to drop it", async () => {
    providerModels.value = { claude: [{ value: `claude-opus-5`, label: `Claude Opus 5` }] };
    settings.value = { ...settings.value, roleSetups: SUGGESTED_PLACES };
    const host = await mountPage();
    expect(host.querySelector(`[data-setup-drop="unassigned"]`)).toBeNull();

    await dragTo(host, labelOf(JUDGE), () => tray(host));
    const { [JUDGE]: _off, ...withoutJudge } = SUGGESTED_PLACES;
    expect(patch).toHaveBeenLastCalledWith({ roleSetups: withoutJudge });
    expect(jobsOf(tray(host))).toEqual([labelOf(JUDGE)]);

    await dragTo(host, labelOf(RUN), () => host.querySelector(`[data-setup-drop="new"]`)!);
    // A copy of what it ran, so the move changes nothing until the new setup is edited.
    expect(patch).toHaveBeenLastCalledWith({
        modelSetups: [{ id: `setup-1`, name: `Setup 1`, pins: [{ provider: `claude`, model: `claude-opus-5` }] }],
        roleSetups: { ...withoutJudge, [RUN]: `setup-1` },
    });
});

test("a touch on a chip never starts a drag: it opens the panel, which places the job the same way", async () => {
    const host = await mountPage();
    chip(host, labelOf(COMMIT)).dispatchEvent(new PointerEvent(`pointerdown`, { bubbles: true, button: 0, pointerType: `touch` }));
    window.dispatchEvent(new PointerEvent(`pointermove`, { clientX: 80, clientY: 80 }));
    await flush();
    expect(host.querySelector(`[data-setup-drop="new"]`)).toBeNull();

    await openJob(host, labelOf(COMMIT));
    expect(document.querySelector(`.job-panel`)?.textContent).toContain(MODEL_ROLES.find((role) => role.id === COMMIT)!.blurb);
    expect(choices()).toEqual([`Low (suggested)`, `Medium`, `High`, `Not assigned`, `New setup`]);
    expect(ticked()).toBe(`Not assigned`);

    await choose(`Medium`);
    expect(patch).toHaveBeenCalledWith({ roleSetups: { [COMMIT]: `medium` } });
    expect(document.querySelector(`.job-panel`)).toBeNull();
});

test("not assigned is said in the words the job's kind needs", async () => {
    const host = await mountPage();

    await openJob(host, labelOf(COMMIT));
    expect(document.querySelector(`.job-panel`)?.textContent).toContain(`Doesn't run`);
    await openJob(host, labelOf(COMMIT));
    await openJob(host, labelOf(RUN));
    expect(document.querySelector(`.job-panel`)?.textContent).toContain(`Opens on your chat's model`);
});

/* WHAT ONE JOB CARRIES BESIDE ITS SETUP */

test("with the judge off its chip says it is not in use, and its panel says where the switch is", async () => {
    settings.value = { ...settings.value, commandJudge: `off` };
    const host = await mountPage();

    expect(chip(host, labelOf(JUDGE)).textContent).toContain(`not in use`);
    await openJob(host, labelOf(JUDGE));
    const link = [...document.querySelectorAll<HTMLAnchorElement>(`.job-panel a[href]`)].find((anchor) => anchor.textContent?.includes(`Turn the judge on`));
    expect(link?.getAttribute(`href`)).toBe(`/sandbox/agent?section=safety`);
});

test("with the judge merely watching its chip is like any other", async () => {
    settings.value = { ...settings.value, commandJudge: `watch` };
    const host = await mountPage();

    expect(chip(host, labelOf(JUDGE)).textContent).not.toContain(`not in use`);
});

test("the router's guidance is opened from its panel and handed over as it was saved", async () => {
    settings.value = { ...settings.value, autoModelGuidance: `Cheap work goes to Haiku.` };
    const host = await mountPage();
    expect(chip(host, labelOf(ROUTER)).textContent).toContain(`guided`);
    expect(chip(host, labelOf(COMMIT)).textContent).not.toContain(`guided`);

    await openJob(host, labelOf(ROUTER));
    pressed(document.querySelector<HTMLElement>(`.job-panel`)!, `Guidance`).click();
    await flush();

    expect(doc?.stored).toBe(`Cheap work goes to Haiku.`);
    // Not transcribed: the cap the page draws is the cap the schema would refuse past.
    const cap = doc?.maxChars ?? 0;
    expect(SandboxSettingsSchema.safeParse({ autoModelGuidance: `x`.repeat(cap) }).success).toBe(true);
    expect(SandboxSettingsSchema.safeParse({ autoModelGuidance: `x`.repeat(cap + 1) }).success).toBe(false);

    saveDoc?.(`  Leave the work account alone.\n`);
    expect(patch).toHaveBeenLastCalledWith({ autoModelGuidance: `Leave the work account alone.` });
});

// "Change in Models" on Safety names the judge's job: the page lands on its chip, with its panel open.
test("a link naming a job opens that job's panel and drops the name from the address", async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this.closest(`li`)?.id ?? ``);
    };
    await router.push({ name: `sandbox`, params: { tab: `agent` }, query: { job: JUDGE } });
    mount();
    await flush();
    await flush();

    expect(scrolled).toEqual([`model-job-${JUDGE}`]);
    expect(document.querySelector(`.job-panel`)?.textContent).toContain(labelOf(JUDGE));
    expect(router.currentRoute.value.query).toEqual({});
});
