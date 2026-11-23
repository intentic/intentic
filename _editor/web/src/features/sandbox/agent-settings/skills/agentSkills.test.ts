// Every skill is a name on a labelled shelf, the reader's own first. A switch appears only where the daemon says the skill
// is switchable, and a press anywhere else on a skill opens its page beside Settings, so the reader never leaves it.
import "@intentic/testing/dom";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import { type SandboxSettings, type SkillSummary, SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import PrimeVue from "primevue/config";
import { stubGlobal } from "@intentic/testing/bun";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Needs jsdom: useDevice reads window.matchMedia and environment.ts reads window.env at import.

// BrandMark fetches a mark from an icon CDN; stubbed to fail like an offline sandbox, falling to the glyph tier.
stubGlobal(`fetch`, () => Promise.resolve({ ok: false, text: () => Promise.resolve(``) }));

const skills = ref<SkillSummary[]>([]);
const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const capabilities = ref<CapabilitySummary[]>([]);
const setEnabled = jest.fn();
const revealSideView = jest.fn((_view: string, _input: object, _options: object) => true);
const push = jest.fn();

jest.mock(`../../environment/useSkills`, () => ({
    useSkills: () => ({
        skills,
        settings,
        loaded: computed(() => ({ state: `ready`, data: [skills.value, settings.value], refreshing: false, refreshError: undefined })),
        setEnabled,
    }),
}));
jest.mock(`../../../../models/capabilities/useCapabilities`, () => ({ useCapabilities: () => ({ capabilities }) }));
jest.mock(`../../../../models/extensions/useExtensions`, () => ({ useExtensions: () => ({ enabled: ref<ExtensionSummary[]>([]) }) }));
// A desktop window: the shell has docked a side panel to open things beside the section.
jest.mock(`../../../../workbench/side/sideTabs`, () => ({ sideDocked: ref(true) }));
jest.mock(`../../../../workbench/side/sideViews`, () => ({ revealSideView }));
jest.mock(`vue-router`, () => ({ useRouter: () => ({ push }) }));
// The page is SkillPage's own test; here it only matters that a phone would get one.
jest.mock(`./SkillPage.vue`, () => ({ default: { name: `SkillPageStub`, render: () => null } }));

const { default: AgentSkills } = await import("./AgentSkills.vue");

const skill = (over: Partial<SkillSummary>): SkillSummary => ({
    id: `notes`,
    name: `notes`,
    description: `Use when the user asks for notes.`,
    origin: `own`,
    enabled: true,
    switchable: true,
    editable: true,
    removable: true,
    ...over,
});

const borrowed = (name: string, origin: SkillSummary[`origin`], owner?: string): SkillSummary =>
    skill({ id: `${origin}:${owner ?? name}:${name}`, name, origin, owner, switchable: false, editable: false, removable: false });

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentSkills) });
    // Icon/tooltip are stubbed; PrimeVue itself is still installed since inputs read its config at render.
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    skills.value = [];
    capabilities.value = [];
    settings.value = SandboxSettingsSchema.parse({});
    setEnabled.mockClear();
    revealSideView.mockClear();
    push.mockClear();
});

const chips = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`[data-skill-chip]`)];
const chip = (host: HTMLElement, name: string): HTMLElement | undefined =>
    chips(host).find((entry) => entry.querySelector(`[data-skill-name]`)?.textContent?.trim() === name);
const shelves = (host: HTMLElement): [string, string[]][] =>
    [...host.querySelectorAll(`dl > div`)].map((row) => [
        row.querySelector(`dt`)?.textContent?.trim() ?? ``,
        [...row.querySelectorAll(`[data-skill-name]`)].map((name) => name.textContent?.trim() ?? ``),
    ]);
const switchOf = (element: HTMLElement | undefined): HTMLElement | null =>
    element?.querySelector<HTMLElement>(`[role="switch"], input[type="checkbox"]`) ?? null;
const button = (host: HTMLElement, label: string): HTMLElement | undefined =>
    [...host.querySelectorAll<HTMLElement>(`button`)].find((element) => element.textContent?.trim() === label);
const filterField = (host: HTMLElement): HTMLInputElement | null => host.querySelector<HTMLInputElement>(`[role="searchbox"]`);
const type = async (field: HTMLInputElement, value: string): Promise<void> => {
    field.value = value;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
};

test(`every skill is a name on a shelf: the reader's own first, then role kits, then where the rest came from`, () => {
    skills.value = [
        skill({ id: `notes`, name: `notes` }),
        skill({ id: `triage`, name: `triage`, origin: `role`, owner: `Support`, switchable: false, editable: false, removable: false }),
        skill({ id: `scratch`, name: `scratch`, origin: `dropped`, switchable: false, editable: false }),
        skill({ id: `lsp`, name: `lsp`, origin: `builtin`, editable: false, removable: false }),
        borrowed(`product-copy`, `extension`, `Storefront`),
        borrowed(`prod-box`, `capability`, `prod`),
    ];
    capabilities.value = [{ id: `prod`, kind: `ssh`, status: { state: `active` }, config: {}, secrets: [] }];
    const host = mount();
    // The Connections catalog's own section names after the reader's own, then extensions together, then the image's.
    expect(shelves(host)).toEqual([
        [`Yours`, [`notes`, `scratch`]],
        [`Roles`, [`triage`]],
        [`Servers`, [`prod-box`]],
        [`Extensions & plugins`, [`product-copy`]],
        [`Built in`, [`lsp`]],
    ]);
});

test(`a switch appears only where the daemon says one works, and writes that skill without opening it`, async () => {
    skills.value = [
        skill({ id: `notes`, name: `notes` }),
        skill({ id: `lsp`, name: `lsp`, origin: `builtin`, enabled: false, editable: false, removable: false }),
        // Not switchable: on because the thing that ships it is on.
        borrowed(`product-copy`, `extension`, `Storefront`),
    ];
    const host = mount();
    expect(switchOf(chip(host, `notes`))).not.toBeNull();
    expect(switchOf(chip(host, `product-copy`))).toBeNull();
    // An off built-in is an offer: it keeps its switch, drawn quieter.
    switchOf(chip(host, `lsp`))?.click();
    await nextTick();
    expect(setEnabled).toHaveBeenCalledWith(expect.objectContaining({ name: `lsp` }), true);
    expect(revealSideView).not.toHaveBeenCalled();
});

test(`pressing a skill opens its page beside Settings, as a look the next press replaces, and never leaves the section`, async () => {
    skills.value = [skill({ id: `notes`, name: `notes` }), borrowed(`product-copy`, `extension`, `Storefront`)];
    const host = mount();
    chip(host, `notes`)?.querySelector<HTMLElement>(`button`)?.click();
    chip(host, `product-copy`)?.querySelector<HTMLElement>(`button`)?.click();
    await nextTick();
    expect(revealSideView.mock.calls).toEqual([
        [`skill`, { skill: `notes`, name: `notes` }, { keep: false }],
        [`skill`, { skill: `extension:Storefront:product-copy`, name: `product-copy` }, { keep: false }],
    ]);
    expect(push).not.toHaveBeenCalled();
});

test(`Write a skill opens the page the new skill will become, kept, so the next press elsewhere can't replace it`, async () => {
    const host = mount();
    button(host, `Write a skill`)?.click();
    await nextTick();
    expect(revealSideView).toHaveBeenCalledWith(`skill`, { skill: `+new`, name: `New skill` }, { keep: true });
});

test(`a trigger line the reader can fix is flagged on their own skill when it names no occasion, and nowhere else`, () => {
    skills.value = [
        skill({ id: `blank`, name: `blank`, description: `` }),
        skill({ id: `label`, name: `label`, description: `The summary scanner brief for Replay vision` }),
        skill({ id: `fine`, name: `fine` }),
        // Nobody here can rewrite an extension's trigger line, so a doubt about it would only be noise.
        { ...borrowed(`terse`, `extension`, `Storefront`), description: `A brief` },
    ];
    const host = mount();
    expect(chip(host, `blank`)?.textContent).toContain(`No trigger`);
    expect(chip(host, `label`)?.textContent).toContain(`Vague trigger`);
    expect(chip(host, `fine`)?.textContent).not.toContain(`trigger`);
    expect(chip(host, `terse`)?.textContent).not.toContain(`trigger`);
});

test(`with none of their own, the reader's shelf stays and says how to start`, () => {
    skills.value = [skill({ id: `lsp`, name: `lsp`, origin: `builtin`, editable: false, removable: false })];
    const host = mount();
    expect(shelves(host)[0]).toEqual([`Yours`, []]);
    expect(host.textContent).toContain(`None yet. Write one`);
});

test(`no filter until the list is long enough to need one, then it reaches every shelf, by name and by origin`, async () => {
    skills.value = [skill({ id: `notes`, name: `notes` })];
    const short = mount();
    expect(filterField(short)).toBeNull();
    app?.unmount();

    skills.value = [
        skill({ id: `notes`, name: `notes` }),
        ...Array.from({ length: 8 }, (_, index) => borrowed(`site-${index}`, `capability`, `site-${index}`)),
        borrowed(`product-copy`, `extension`, `Storefront`),
    ];
    const host = mount();
    const field = filterField(host);
    expect(field).not.toBeNull();
    await type(field as HTMLInputElement, `storefront`);
    expect(shelves(host)).toEqual([[`Extensions & plugins`, [`product-copy`]]]);
    await type(field as HTMLInputElement, `nothing-like-this`);
    expect(host.textContent).toContain(`Nothing matches that filter.`);
    // A filter that hides every one of the reader's own is not an empty shelf to fill.
    expect(host.textContent).not.toContain(`None yet. Write one`);
});
