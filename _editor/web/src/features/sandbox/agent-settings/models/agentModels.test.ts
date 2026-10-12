// Pins that the page draws one row per list the jobs actually hold, that a row's edit lands on every job in it and on
// nothing else, and that moving a job changes that job alone. Mounted, since what's tested is the click-through round
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

// Representative jobs: ordinary one-shots (`commit-message`, `session-title`), one with an external switch
// (`safety-judge`), the one with a second setting (`model-router`), and sessions (`pipeline-fix`, `refactor-run`).
const COMMIT = `commit-message` as const;
const TITLE = `session-title` as const;
const JUDGE = `safety-judge` as const;
const ROUTER = `model-router` as const;
const RUN = `pipeline-fix` as const;
const REFACTOR = `refactor-run` as const;

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
// Empty `providerModels`: puts every model on the static effort scale, the state every fixture here assumes.
jest.mock(`../../../chat/accounts/providerCatalog`, () => ({
    endpointProviders: ref([]),
    providerModels: ref({}),
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
    opened = undefined;
    answer = undefined;
    doc = undefined;
    saveDoc = undefined;
    patch.mockClear();
});

const labelOf = (role: string): string => MODEL_ROLES.find((spec) => spec.id === role)!.label;
const ALL = MODEL_ROLES.map((role) => role.label);

// Each row on the page, top to bottom: the jobs it names, and the element itself for scoping a press to it.
const rows = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`section .group`)];
const jobsOf = (row: HTMLElement): string[] =>
    [...row.querySelectorAll(`li[id^="model-job-"] button > span:first-of-type`)].map((label) => label.textContent?.trim() ?? ``);
const layoutOf = (host: HTMLElement): string[][] => rows(host).map(jobsOf);
const rowWith = (host: HTMLElement, job: string): HTMLElement => rows(host).find((row) => jobsOf(row).includes(job))!;
const sectionLabels = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(`section`)].map((section) => section.querySelector(`span`)?.textContent?.trim() ?? ``);

// Reading order off screen: one entry per model, in list order.
const orderOn = (scope: HTMLElement): string[] =>
    [...scope.querySelectorAll(`ol li`)].map((row) => row.querySelector(`span.flex-1`)?.textContent?.trim() ?? ``).filter((text) => text !== ``);

const button = (scope: HTMLElement, label: string): HTMLButtonElement =>
    [...scope.querySelectorAll<HTMLButtonElement>(`button`)].find((candidate) => candidate.getAttribute(`aria-label`) === label)!;

// A button by the words on it, for the row's verbs, which say what they do rather than carry a hidden name.
const pressed = (scope: HTMLElement, text: string): HTMLButtonElement =>
    [...scope.querySelectorAll<HTMLButtonElement>(`button`)].find((candidate) => candidate.textContent?.trim() === text)!;

const chip = (host: HTMLElement, job: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>(`li[id^="model-job-"] button`)].find(
        (candidate) => candidate.querySelector(`span`)?.textContent?.trim() === job,
    )!;

// The open job panel's choices, by their first line, and which one is ticked.
const choices = (): string[] => [...document.querySelectorAll(`.job-panel [role="radio"] span span:first-child`)].map((line) => line.textContent?.trim() ?? ``);
const ticked = (): string | undefined =>
    document.querySelector(`.job-panel [role="radio"][aria-checked="true"] span span:first-child`)?.textContent?.trim() ?? undefined;
const choose = async (label: string): Promise<void> => {
    [...document.querySelectorAll<HTMLButtonElement>(`.job-panel [role="radio"]`)].find((choice) => choice.querySelector(`span span`)?.textContent?.trim() === label)!.click();
    await flush();
};
const openJob = async (host: HTMLElement, job: string): Promise<void> => {
    chip(host, job).click();
    await flush();
};

const haiku = entry(`claude`, `claude-haiku-4-5`);
const luna = entry(`codex`, `gpt-5.6`);

/* ROWS ARE THE LISTS THE JOBS HOLD */

test("a fresh sandbox is one row: the default, with every job on it", async () => {
    const host = await mountPage();

    expect(layoutOf(host)).toEqual([ALL]);
    expect(sectionLabels(host)).toEqual([`Default models`]);
});

test("jobs holding the same list are one row, however their work is started", async () => {
    settings.value = {
        ...settings.value,
        modelDefault: [haiku],
        modelRoles: { [RUN]: [luna], [REFACTOR]: [luna], [TITLE]: [luna] },
    };
    const host = await mountPage();

    expect(layoutOf(host)).toEqual([ALL.filter((job) => ![RUN, REFACTOR, TITLE].map(labelOf).includes(job)), [labelOf(TITLE), labelOf(RUN), labelOf(REFACTOR)]]);
    expect(sectionLabels(host)).toEqual([`Default models`, `Separate lists`]);
    // Each list drawn once, however many jobs hold it.
    expect(orderOn(rowWith(host, labelOf(RUN)))).toEqual([`CODEX · GPT 5.6 Luna`]);
});

test("jobs holding the same models in a different order are two rows", async () => {
    settings.value = { ...settings.value, modelRoles: { [RUN]: [luna, haiku], [REFACTOR]: [haiku, luna] } };
    const host = await mountPage();

    expect(layoutOf(host).slice(1)).toEqual([[labelOf(RUN)], [labelOf(REFACTOR)]]);
});

test("an empty list says what its jobs do without one, once the settings have landed", async () => {
    settings.value = undefined as unknown as SandboxSettings;
    const before = await mountPage();
    expect(before.textContent).not.toContain(`No models`);
    app?.unmount();
    document.body.innerHTML = ``;

    settings.value = { ...SandboxSettingsSchema.parse({}), modelRoles: { [RUN]: [], [COMMIT]: [haiku] } };
    const host = await mountPage();
    // The default holds one-shots and sessions; the empty separate row holds a session alone.
    expect(rowWith(host, labelOf(TITLE)).textContent).toContain(`one-shot jobs here don't run`);
    expect(rowWith(host, labelOf(RUN)).textContent).toContain(`sessions here open on whatever your chat is set to`);
    expect(rowWith(host, labelOf(COMMIT)).textContent).not.toContain(`No models`);
});

test("the default with no job on it says so, and still takes models for the jobs that will come", async () => {
    settings.value = { ...settings.value, modelRoles: Object.fromEntries(MODEL_ROLES.map((role) => [role.id, [haiku]])) };
    const host = await mountPage();

    expect(rows(host)[0]?.textContent).toContain(`No job runs on these.`);
    expect(button(rows(host)[0]!, `Add a default model`).disabled).toBe(false);
});

/* EDITING A ROW EDITS EVERY JOB IN IT */

test("the default's list is one setting: reordering it writes the default and no job's own list", async () => {
    settings.value = { ...settings.value, modelDefault: [luna, haiku], modelRoles: { [RUN]: [luna] } };
    const host = await mountPage();

    const defaults = rows(host)[0]!;
    expect(orderOn(defaults)).toEqual([`CODEX · GPT 5.6 Luna`, `CLAUDE · Claude Haiku 4.5`]);
    expect(button(defaults, `Move CODEX · GPT 5.6 Luna earlier`).disabled).toBe(true);
    button(defaults, `Move CLAUDE · Claude Haiku 4.5 earlier`).click();

    expect(patch).toHaveBeenCalledWith({ modelDefault: [haiku, luna] });
});

test("a separate row writes its whole list into every job on it, in one patch, and leaves other jobs standing", async () => {
    settings.value = { ...settings.value, modelRoles: { [RUN]: [luna], [REFACTOR]: [luna], [COMMIT]: [haiku] } };
    const host = await mountPage();

    button(rowWith(host, labelOf(RUN)), `Add a model for Pipeline fixes, Refactors`).click();
    await flush();
    answer?.pick(haiku);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({ modelRoles: { [RUN]: [luna, haiku], [REFACTOR]: [luna, haiku], [COMMIT]: [haiku] } });
});

test("emptying a separate row leaves its jobs with no models, rather than handing them to the default", async () => {
    settings.value = { ...settings.value, modelDefault: [haiku], modelRoles: { [RUN]: [luna], [REFACTOR]: [luna] } };
    const host = await mountPage();

    button(rowWith(host, labelOf(RUN)), `Remove CODEX · GPT 5.6 Luna`).click();
    await flush();

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [RUN]: [], [REFACTOR]: [] } });
    // Still their own row, now saying what an empty list means.
    expect(layoutOf(host).slice(1)).toEqual([[labelOf(RUN), labelOf(REFACTOR)]]);
});

test("keeps a pin whose account went away on screen, and greys it", async () => {
    settings.value = { ...settings.value, modelDefault: [entry(`gemini`, `gemini-3-flash-lite`), haiku] };
    const host = await mountPage();

    expect(orderOn(host)).toEqual([`GEMINI · Gemini 3 Flash Lite`, `CLAUDE · Claude Haiku 4.5`]);
    expect(host.querySelector(`ol li`)?.className).toMatch(/subtle/);
});

test("an entry names the tier it will run at, and one left at the provider's default names nothing", async () => {
    settings.value = {
        ...settings.value,
        modelDefault: [
            { provider: `claude`, model: `claude-haiku-4-5`, effort: `max`, thinking: false },
            { provider: `codex`, model: `gpt-5.6` },
        ],
    };
    const host = await mountPage();

    const lines = [...host.querySelectorAll(`ol li`)].map((row) => row.textContent?.replace(/\s+/g, ` `).trim() ?? ``);
    // Claude refuses `max` with thinking off, so the row shows what will actually run, not the stored pick.
    expect(lines[0]).toContain(`X-High`);
    expect(lines[1]).not.toMatch(/High|Low|thinking/);
});

test("a knob moved in the picker lands on that entry alone, in every job on the row", async () => {
    settings.value = { ...settings.value, modelRoles: { [RUN]: [luna, haiku], [REFACTOR]: [luna, haiku] } };
    const host = await mountPage();

    button(rowWith(host, labelOf(RUN)), `Change CLAUDE · Claude Haiku 4.5`).click();
    await flush();
    expect([opened?.pin, opened?.knobs, opened?.taken]).toEqual([haiku, true, [`codex:gpt-5.6`, `claude:claude-haiku-4-5`]]);

    const tuned = { ...haiku, effort: `max`, thinking: true };
    answer?.configure(tuned);

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [RUN]: [luna, tuned], [REFACTOR]: [luna, tuned] } });
    // The panel stays open and re-reads the entry's new state live.
    await flush();
    expect(opened?.pin).toEqual(tuned);
});

test("re-pointing an entry replaces it where it stands, because its position is the other half of the setting", async () => {
    settings.value = { ...settings.value, modelDefault: [luna, haiku] };
    const host = await mountPage();
    button(host, `Change CODEX · GPT 5.6 Luna`).click();
    await flush();

    const opus = entry(`claude`, `claude-opus-5`, { effort: `max` });
    answer?.pick(opus);

    expect(patch).toHaveBeenCalledWith({ modelDefault: [opus, haiku] });
});

test("adding to a list ticks its first model and says the new one is a fallback", async () => {
    settings.value = { ...settings.value, modelDefault: [luna] };
    const host = await mountPage();

    button(host, `Add a default model`).click();
    await flush();
    expect([opened?.header, opened?.current, opened?.pin]).toEqual([`Add a fallback model`, luna, undefined]);
    expect(host.textContent).not.toContain(`Tried in order`);

    answer?.pick(haiku);
    await flush();
    expect(patch).toHaveBeenCalledWith({ modelDefault: [luna, haiku] });
    expect(host.textContent).toContain(`Tried in order`);
});

test("adding to an empty list ticks nothing", async () => {
    const host = await mountPage();

    button(host, `Add a default model`).click();
    await flush();

    expect([opened?.header, opened?.current]).toEqual([`Add a model`, undefined]);
});

test("a second press on the trigger that opened the picker closes it", async () => {
    const host = await mountPage();
    const add = button(host, `Add a default model`);

    add.click();
    await flush();
    expect(opened?.open).toBe(true);

    add.click();
    await flush();
    expect(opened?.open).toBe(false);
});

test("a model that cannot run a turn is offered only to a list that feeds nothing but one-shot jobs", async () => {
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [haiku], [TITLE]: [haiku] } };
    const host = await mountPage();

    button(rowWith(host, labelOf(COMMIT)), `Add a model for Commit messages, Session titles`).click();
    await flush();
    expect(opened?.helperJobs).toBe(true);

    button(host, `Add a default model`).click();
    await flush();
    expect(opened?.helperJobs).toBe(false);
});

/* MOVING A JOB CHANGES THAT JOB ALONE */

test("a job's panel says what it does and ticks the list it runs on", async () => {
    settings.value = { ...settings.value, modelDefault: [haiku], modelRoles: { [RUN]: [luna], [REFACTOR]: [luna] } };
    const host = await mountPage();

    await openJob(host, labelOf(RUN));

    expect(document.querySelector(`.job-panel`)?.textContent).toContain(MODEL_ROLES.find((role) => role.id === RUN)!.blurb);
    expect(choices()).toEqual([`Default models`, `With Refactors`, `Its own models`, `No models`]);
    expect(ticked()).toBe(`With Refactors`);
});

test("giving a job its own models copies what it ran, and draws it in a row of its own that does not fold back", async () => {
    settings.value = { ...settings.value, modelDefault: [haiku] };
    const host = await mountPage();

    await openJob(host, labelOf(TITLE));
    await choose(`Its own models`);

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [TITLE]: [haiku] } });
    expect(layoutOf(host)).toEqual([ALL.filter((job) => job !== labelOf(TITLE)), [labelOf(TITLE)]]);
    expect(document.querySelector(`.job-panel`)).toBeNull();
});

test("moving a job onto another row gives it that row's list", async () => {
    settings.value = { ...settings.value, modelDefault: [haiku], modelRoles: { [RUN]: [luna] } };
    const host = await mountPage();

    await openJob(host, labelOf(REFACTOR));
    await choose(`With Pipeline fixes`);

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [RUN]: [luna], [REFACTOR]: [luna] } });
    expect(layoutOf(host)[1]).toEqual([labelOf(RUN), labelOf(REFACTOR)]);
});

test("moving a job back to the default drops its own list", async () => {
    settings.value = { ...settings.value, modelDefault: [haiku], modelRoles: { [RUN]: [luna], [REFACTOR]: [luna] } };
    const host = await mountPage();

    await openJob(host, labelOf(RUN));
    await choose(`Default models`);

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [REFACTOR]: [luna] } });
    expect(rows(host)[0] && jobsOf(rows(host)[0]!)).toContain(labelOf(RUN));
});

test("no models is a choice for one job, said in the words its kind of job needs", async () => {
    settings.value = { ...settings.value, modelDefault: [haiku] };
    const host = await mountPage();

    await openJob(host, labelOf(COMMIT));
    expect(document.querySelector(`.job-panel`)?.textContent).toContain(`Doesn't run`);
    await choose(`No models`);

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [COMMIT]: [] } });
});

test("an empty row is offered as No models, never by the jobs on it, and a job on it is ticked there", async () => {
    settings.value = { ...settings.value, modelDefault: [haiku], modelRoles: { [JUDGE]: [] } };
    const host = await mountPage();

    await openJob(host, labelOf(COMMIT));
    expect(choices()).toEqual([`Default models`, `Its own models`, `No models`]);
    await choose(`No models`);
    expect(layoutOf(host)[1]).toEqual([labelOf(COMMIT), labelOf(JUDGE)]);

    await openJob(host, labelOf(JUDGE));
    // A copy of nothing would be No models again, so it is not offered.
    expect(choices()).toEqual([`Default models`, `No models`]);
    expect(ticked()).toBe(`No models`);
});

test("making a row the default moves its jobs onto it, and leaves the old default's jobs on what they ran", async () => {
    settings.value = { ...settings.value, modelDefault: [haiku], modelRoles: { [RUN]: [luna], [REFACTOR]: [luna] } };
    const host = await mountPage();
    const before = jobsOf(rows(host)[0]!);

    pressed(rowWith(host, labelOf(RUN)), `Make default`).click();
    await flush();

    const written = patch.mock.calls.at(-1)?.[0];
    expect(written?.modelDefault).toEqual([luna]);
    expect(Object.keys(written?.modelRoles ?? {})).not.toContain(RUN);
    expect(Object.values(written?.modelRoles ?? {}).every((pins) => JSON.stringify(pins) === JSON.stringify([haiku]))).toBe(true);
    expect(layoutOf(host)).toEqual([[labelOf(RUN), labelOf(REFACTOR)], before]);
});

test("a row can hand all its jobs back to the default in one press", async () => {
    settings.value = { ...settings.value, modelDefault: [haiku], modelRoles: { [RUN]: [luna], [REFACTOR]: [luna], [COMMIT]: [luna, haiku] } };
    const host = await mountPage();

    pressed(rowWith(host, labelOf(RUN)), `Back to default`).click();

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [COMMIT]: [luna, haiku] } });
});

/* WHAT ONE JOB CARRIES BESIDE ITS LIST */

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
    expect(doc).toBeUndefined();

    await openJob(host, labelOf(ROUTER));
    [...document.querySelectorAll<HTMLButtonElement>(`.job-panel button`)].find((candidate) => candidate.textContent?.trim() === `Guidance`)!.click();
    await flush();

    expect(doc?.stored).toBe(`Cheap work goes to Haiku.`);
    // Not transcribed: the cap the page draws is the cap the schema would refuse past.
    const cap = doc?.maxChars ?? 0;
    expect(SandboxSettingsSchema.safeParse({ autoModelGuidance: `x`.repeat(cap) }).success).toBe(true);
    expect(SandboxSettingsSchema.safeParse({ autoModelGuidance: `x`.repeat(cap + 1) }).success).toBe(false);

    saveDoc?.(`  Leave the work account alone.\n`);
    expect(patch).toHaveBeenLastCalledWith({ autoModelGuidance: `Leave the work account alone.` });
});

// Written guidance steers every chat that opens on Auto; no model list on this page would show that it exists.
test("the router's chip says it is guided while it holds guidance, and no other chip does", async () => {
    const empty = await mountPage();
    expect(chip(empty, labelOf(ROUTER)).textContent).not.toContain(`guided`);
    app?.unmount();
    document.body.innerHTML = ``;

    settings.value = { ...settings.value, autoModelGuidance: `Cheap work goes to Haiku.` };
    const host = await mountPage();
    expect(chip(host, labelOf(ROUTER)).textContent).toContain(`guided`);
    expect(chip(host, labelOf(COMMIT)).textContent).not.toContain(`guided`);
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
