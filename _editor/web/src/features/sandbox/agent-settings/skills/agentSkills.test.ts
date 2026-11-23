// The reader's own skills are cards with their whole trigger line; everything that arrived with something else is a name
// on a labelled shelf. A switch appears only where the daemon says the skill is switchable, and a press anywhere else on
// a skill opens its page: a Workspace tab on a desktop, so the list never grows a drawer.
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
const openSkill = jest.fn();
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
jest.mock(`../../../../models/workspace/tabs/useWorkspaceTabs`, () => ({ useWorkspaceTabs: () => ({ openSkill }) }));
jest.mock(`../../../../workbench/views/registry`, () => ({ sectionReachable: () => true }));
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
    openSkill.mockClear();
    push.mockClear();
});

const cards = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`[data-skill-card]`)];
const chips = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`[data-skill-chip]`)];
const switches = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`[role="switch"], input[type="checkbox"]`)];
const shelfLabels = (host: HTMLElement): string[] => [...host.querySelectorAll(`dt`)].map((term) => term.textContent?.trim() ?? ``);
const button = (host: HTMLElement, label: string): HTMLElement | undefined =>
    [...host.querySelectorAll<HTMLElement>(`button`)].find((element) => element.textContent?.trim() === label);
const filterField = (host: HTMLElement): HTMLInputElement | null => host.querySelector<HTMLInputElement>(`[role="searchbox"]`);
const type = async (field: HTMLInputElement, value: string): Promise<void> => {
    field.value = value;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
};

test(`the reader's own words are cards, and what came with something else sits on shelves named for where it came from`, () => {
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
    expect(cards(host).map((card) => card.querySelector(`button`)?.textContent?.trim())).toEqual([`notes`, `triage`, `scratch`]);
    expect(chips(host).map((chip) => chip.textContent?.trim())).toEqual([`prod-box`, `product-copy`, `lsp`]);
    // The Connections catalog's own section names, then extensions together, then what the image ships.
    expect(shelfLabels(host)).toEqual([`Servers`, `Extensions & plugins`, `Built in`]);
    // A role's kit says whose turns it reaches, the one fact a card can't otherwise show.
    expect(cards(host)[1]?.textContent).toContain(`Role · Support`);
});

test(`a switch appears only where the daemon says one works, and writes that skill`, async () => {
    skills.value = [
        skill({ id: `notes`, name: `notes` }),
        skill({ id: `lsp`, name: `lsp`, origin: `builtin`, enabled: false, editable: false, removable: false }),
        // Not switchable: on because the thing that ships it is on.
        borrowed(`product-copy`, `extension`, `Storefront`),
    ];
    const host = mount();
    expect(switches(host)).toHaveLength(2);
    expect(chips(host).find((chip) => chip.textContent?.includes(`product-copy`))?.querySelector(`[role="switch"], input[type="checkbox"]`)).toBeNull();
    // An off built-in is an offer: it keeps its switch, drawn quieter.
    const offChip = chips(host).find((chip) => chip.textContent?.includes(`lsp`));
    offChip?.querySelector<HTMLElement>(`input[type="checkbox"], [role="switch"]`)?.click();
    await nextTick();
    expect(setEnabled).toHaveBeenCalledWith(expect.objectContaining({ name: `lsp` }), true);
    expect(openSkill).not.toHaveBeenCalled();
});

test(`pressing a skill opens its page as a Workspace tab, card or chip alike`, async () => {
    skills.value = [skill({ id: `notes`, name: `notes` }), borrowed(`product-copy`, `extension`, `Storefront`)];
    const host = mount();
    cards(host)[0]?.querySelector<HTMLElement>(`button`)?.click();
    chips(host)[0]?.querySelector<HTMLElement>(`button`)?.click();
    await nextTick();
    expect(openSkill.mock.calls).toEqual([
        [`notes`, `notes`],
        [`extension:Storefront:product-copy`, `product-copy`],
    ]);
    expect(push).toHaveBeenCalledTimes(2);
});

test(`Write a skill is the section's header action, and opens the page the new skill will become`, async () => {
    const host = mount();
    button(host, `Write a skill`)?.click();
    await nextTick();
    expect(openSkill).toHaveBeenCalledWith(`+new`, `New skill`);
});

test(`a missing or vague trigger line is called out on its card, since it is what the agent picks a skill by`, () => {
    skills.value = [
        skill({ id: `blank`, name: `blank`, description: `` }),
        skill({ id: `label`, name: `label`, description: `The summary scanner brief for Replay vision` }),
        skill({ id: `fine`, name: `fine` }),
    ];
    const host = mount();
    const card = (name: string): HTMLElement | undefined => cards(host).find((entry) => entry.querySelector(`button`)?.textContent?.trim() === name);
    const [blank, label, fine] = [card(`blank`), card(`label`), card(`fine`)];
    expect(blank?.textContent).toContain(`No description`);
    expect(label?.textContent).toContain(`not when to use it`);
    expect(fine?.textContent).not.toContain(`not when to use it`);
});

test(`a card says how often turns reach for it, and nothing at all where the sandbox does not count`, () => {
    skills.value = [
        skill({ id: `busy`, name: `busy`, uses: { week: 9, last: new Date().toISOString() } }),
        skill({ id: `idle`, name: `idle`, uses: { week: 0 } }),
        skill({ id: `older`, name: `older` }),
    ];
    const host = mount();
    const [busy, idle, older] = cards(host);
    expect(busy?.textContent).toContain(`9 turns this week`);
    expect(idle?.textContent).toContain(`Not used this week`);
    expect(older?.textContent).not.toContain(`this week`);
});

test(`with none of their own, the reader is told so rather than shown an empty grid`, () => {
    skills.value = [skill({ id: `lsp`, name: `lsp`, origin: `builtin`, editable: false, removable: false })];
    const host = mount();
    expect(cards(host)).toHaveLength(0);
    expect(host.textContent).toContain(`None of your own yet`);
});

test(`no filter until the list is long enough to need one, then it reaches cards and shelves, by name and by origin`, async () => {
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
    expect(cards(host)).toHaveLength(0);
    expect(chips(host).map((chip) => chip.textContent?.trim())).toEqual([`product-copy`]);
    await type(field as HTMLInputElement, `nothing-like-this`);
    expect(host.textContent).toContain(`Nothing matches that filter.`);
    // A filter that hides every card is not an empty workspace.
    expect(host.textContent).not.toContain(`None of your own yet`);
});
