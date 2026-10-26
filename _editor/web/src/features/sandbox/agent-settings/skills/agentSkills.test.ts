// A row's controls (switch, edit, delete) come only from what the daemon reports for its origin, and every origin
// gets a row, including a disabled built-in. Reading and editing happen on the row's own click, not a menu.
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
const setEnabled = jest.fn();
const removeMutate = jest.fn();
const saveMutate = jest.fn();

jest.mock(`../../environment/useSkills`, () => ({
    useSkills: () => ({
        skills,
        settings,
        loaded: computed(() => ({ state: `ready`, data: [skills.value, settings.value], refreshing: false, refreshError: undefined })),
        save: { mutateAsync: saveMutate, isPending: ref(false) },
        remove: { mutate: removeMutate },
        setEnabled,
        readBody: async () => ({ id: `x`, name: `x`, body: `## Body.` }),
        forgetBody: jest.fn(),
    }),
}));

// Both empty: what each tier draws from them is skillVisual's own test; this file is about controls.
jest.mock(`../../../../models/capabilities/useCapabilities`, () => ({
    useCapabilities: () => ({ capabilities: ref<CapabilitySummary[]>([]) }),
}));
jest.mock(`../../../../models/extensions/useExtensions`, () => ({
    useExtensions: () => ({ enabled: ref<ExtensionSummary[]>([]) }),
}));

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
    settings.value = SandboxSettingsSchema.parse({});
    setEnabled.mockClear();
    removeMutate.mockClear();
    saveMutate.mockReset();
});

// A sandbox with many connections; each account ships its own cheatsheet skill.
const fromConnections = (count: number): SkillSummary[] =>
    Array.from({ length: count }, (_, index) =>
        skill({
            id: `capability:site-${index}:site-${index}`,
            name: `site-${index}`,
            description: `Act as the signed-in user.`,
            origin: `capability`,
            owner: `site-${index}`,
            switchable: false,
            editable: false,
            removable: false,
        }),
    );

const switches = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll(`[role="switch"], input[type="checkbox"]`)] as HTMLElement[];
const fold = (host: HTMLElement): HTMLDetailsElement | null => host.querySelector(`details`);
const filterField = (host: HTMLElement): HTMLInputElement | null => host.querySelector<HTMLInputElement>(`[role="searchbox"]`);
const type = async (field: HTMLInputElement, value: string): Promise<void> => {
    field.value = value;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
};
// The row's own header button: the one gesture that opens a skill.
const rows = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll(`button[aria-expanded]`)] as HTMLElement[];
const button = (host: HTMLElement, label: string): HTMLElement | undefined =>
    [...host.querySelectorAll(`button`)].find((element) => element.textContent?.trim() === label);
// The body arrives via fetch; opening a row must resolve that promise before rendering.
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

test(`the switch appears only on rows the daemon said are switchable, and writes the skill's name`, async () => {
    skills.value = [
        skill({ id: `notes`, name: `notes` }),
        skill({ id: `lsp`, name: `lsp`, origin: `builtin`, editable: false, removable: false }),
        // Not switchable: each depends on something else (an extension, plugin or connection) being on.
        skill({ id: `plugin:pack:review`, name: `review`, origin: `plugin`, owner: `pack`, switchable: false, editable: false, removable: false }),
        skill({ id: `github`, name: `github`, origin: `capability`, owner: `github`, switchable: false, editable: false, removable: false }),
    ];
    const host = mount();

    expect(switches(host)).toHaveLength(2);
    switches(host)[0]?.click();
    await Promise.resolve();
    // The row itself, not its name: which door the write takes depends on where the skill came from.
    expect(setEnabled).toHaveBeenCalledWith(expect.objectContaining({ name: `notes`, origin: `own` }), false);
});

test(`a switched-off skill still gets a row, drained and switchable`, () => {
    skills.value = [skill({ id: `lsp`, name: `lsp`, origin: `builtin`, enabled: false, editable: false, removable: false })];
    const host = mount();

    expect(host.textContent).toContain(`lsp`);
    expect(switches(host)).toHaveLength(1);
    // <BrandMark idle> renders as grayscale, so the same signal reaches a reader who can't see color.
    expect(host.querySelector(`.grayscale`)).not.toBeNull();
});

test(`each row names where it came from, with its owner when it has one`, () => {
    skills.value = [
        skill({ id: `plugin:pack:review`, name: `review`, origin: `plugin`, owner: `pack`, switchable: false, editable: false, removable: false }),
        skill({ id: `scratch`, name: `scratch`, origin: `dropped`, switchable: false, editable: false, removable: true }),
    ];
    const host = mount();

    expect(host.textContent).toContain(`pack`);
    expect(host.textContent).toContain(`scratch`);
    expect(host.textContent).not.toContain(`Remove the plugin`);
});

test(`a missing description is called out rather than left blank`, () => {
    skills.value = [skill({ description: `Use when the user asks for notes.` })];
    const withDescription = mount().textContent ?? ``;
    app?.unmount();
    skills.value = [skill({ description: `` })];
    const without = mount().textContent ?? ``;
    expect(without).not.toBe(withDescription);
});

test(`an empty list invites the first skill rather than reading as a failure`, () => {
    const host = mount();
    expect(rows(host)).toHaveLength(0);
    expect(host.querySelector(`button`)).not.toBeNull();
});

test(`a row opens itself and closes itself, with nothing to discover first`, async () => {
    skills.value = [skill({})];
    const host = mount();

    expect(host.querySelector(`[aria-label="Skill actions"]`)).toBeNull();
    expect(rows(host)[0]?.getAttribute(`aria-expanded`)).toBe(`false`);

    rows(host)[0]?.click();
    await settle();
    expect(rows(host)[0]?.getAttribute(`aria-expanded`)).toBe(`true`);
    expect(host.querySelector(`[aria-label="What this skill should do"]`)).not.toBeNull();

    rows(host)[0]?.click();
    await settle();
    expect(rows(host)[0]?.getAttribute(`aria-expanded`)).toBe(`false`);
    expect(host.querySelector(`[aria-label="What this skill should do"]`)).toBeNull();
});

// No separate Source view: the document reveals markup under a caret, so a toggle would just repeat it.
test(`a skill the owner can't edit opens as its own prose, with the file one Copy away and no source pill`, async () => {
    skills.value = [skill({ id: `scratch`, name: `scratch`, origin: `dropped`, switchable: false, editable: false })];
    const host = mount();

    rows(host)[0]?.click();
    await settle();
    expect(host.querySelector(`.md-prose`)?.innerHTML).toContain(`<h2`);
    expect(button(host, `Source`)).toBeUndefined();
    expect(button(host, `Copy`)).not.toBeUndefined();
});

test(`what came with something else folds away once it would bury what can be tuned`, () => {
    skills.value = [skill({ id: `notes`, name: `notes` }), ...fromConnections(20)];
    const host = mount();

    expect(fold(host)?.open).toBe(false);
    expect(host.textContent).toContain(`20`);
    expect(host.textContent).toContain(`notes`);
    expect(switches(host)).toHaveLength(1);
});

// Too few rows for the fold to save a click.
test(`a short list is left open`, () => {
    skills.value = [skill({ id: `notes`, name: `notes` }), ...fromConnections(3)];
    expect(fold(mount())?.open).toBe(true);
});

test(`the filter reaches inside the fold, by name and by origin`, async () => {
    skills.value = [skill({ id: `notes`, name: `notes` }), ...fromConnections(20)];
    const host = mount();

    const field = filterField(host);
    expect(field).not.toBeNull();
    await type(field!, `site-7`);
    expect(fold(host)?.open).toBe(true);
    expect(host.textContent).toContain(`site-7`);
    expect(host.textContent).not.toContain(`site-8`);

    // Matches the chip word (`Connection`), not just the name or trigger line.
    await type(field!, `connection`);
    expect(host.textContent).toContain(`site-1`);
    expect(host.textContent).not.toContain(`notes`);

    await type(field!, `nothing-by-this-name`);
    expect(host.querySelectorAll(`ol li`)).toHaveLength(0);
    expect(host.textContent?.trim().length ?? 0).toBeGreaterThan(0);
});

test(`no filter until the list is long enough to need one`, () => {
    skills.value = [skill({ id: `notes`, name: `notes` })];
    expect(filterField(mount())).toBeNull();
});

test(`delete waits for a second press, under the fold`, async () => {
    skills.value = [skill({ id: `scratch`, name: `scratch`, origin: `dropped`, switchable: false, editable: false })];
    const host = mount();

    expect(button(host, `Delete this skill`)).toBeUndefined();
    rows(host)[0]?.click();
    await settle();

    button(host, `Delete this skill`)?.click();
    await nextTick();
    expect(removeMutate).not.toHaveBeenCalled();

    button(host, `Delete`)?.click();
    await nextTick();
    expect(removeMutate).toHaveBeenCalledWith(`scratch`);
});

test(`a skill the reader owns offers delete under its editor`, async () => {
    skills.value = [skill({ id: `notes`, name: `notes` })];
    const host = mount();

    rows(host)[0]?.click();
    await settle();

    // Save changes confirms the editor opened; delete sits below it, not instead of it.
    expect(button(host, `Save changes`)).toEqual(expect.any(Object));
    button(host, `Delete this skill`)?.click();
    await nextTick();
    expect(removeMutate).not.toHaveBeenCalled();

    button(host, `Delete`)?.click();
    await nextTick();
    expect(removeMutate).toHaveBeenCalledWith(`notes`);
});

// The new skill's form: one press on an incomplete form says what is missing under each box and puts the caret in the
// first, rather than a dimmed button that can't be asked why.
const nameField = (host: HTMLElement): HTMLInputElement | null => host.querySelector<HTMLInputElement>(`input[placeholder="e.g. release-notes"]`);

test(`pressing Add skill on an empty form names each missing field and saves nothing`, async () => {
    const host = mount();
    button(host, `Write a skill`)?.click();
    await nextTick();

    // Every example reads as one, so an empty box never passes for a filled one.
    expect(nameField(host)).not.toBeNull();
    expect(host.textContent).not.toContain(`Give it a name.`);

    button(host, `Add skill`)?.click();
    await nextTick();
    expect(saveMutate).not.toHaveBeenCalled();
    expect(host.textContent).toContain(`Give it a name.`);
    expect(host.textContent).toContain(`Say when the agent should reach for it.`);
    expect(host.textContent).toContain(`Write what it should do.`);
    expect(document.activeElement).toBe(nameField(host));
    expect(nameField(host)?.getAttribute(`aria-invalid`)).toBe(`true`);

    // A message leaves as soon as its field is filled.
    await type(nameField(host)!, `changelog`);
    expect(host.textContent).not.toContain(`Give it a name.`);
});

// Saving is an upsert by name, so a new skill named like an existing one would silently replace it.
test(`a new skill can't take a name already in the list`, async () => {
    skills.value = [skill({ id: `notes`, name: `notes` })];
    const host = mount();
    button(host, `Write a skill`)?.click();
    await nextTick();

    await type(nameField(host)!, `notes`);
    expect(host.textContent).toContain(`There's already a skill called notes.`);

    await type(nameField(host)!, `notes-2`);
    expect(host.textContent).not.toContain(`There's already a skill called`);
});

// The row being edited already says its name, and a name can't change once saved.
test(`editing a skill asks only for what can change`, async () => {
    skills.value = [skill({ id: `notes`, name: `notes` })];
    const host = mount();

    rows(host)[0]?.click();
    await settle();
    expect(button(host, `Save changes`)).toEqual(expect.any(Object));
    expect(host.querySelector(`input.font-mono`)).toBeNull();
    expect(host.textContent).toContain(`When to use it`);
});

// The list's own action sits where every list keeps one, top right of its header, and what it makes appears first.
test(`Write a skill is the group's header action, and the skill it starts opens at the top of the list`, async () => {
    skills.value = [skill({ id: `notes`, name: `notes` })];
    const host = mount();

    // In the header line, the section's first child, not among the rows of its card.
    const write = button(host, `Write a skill`);
    const header = host.querySelector(`section`)?.firstElementChild;
    expect(header?.contains(write ?? null)).toBe(true);
    write?.click();
    await nextTick();

    const draft = host.querySelector(`[data-skill-draft]`);
    const firstRow = rows(host)[0];
    expect(draft).not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING: the saved row comes after the draft.
    expect(draft!.compareDocumentPosition(firstRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // The head follows the name being typed, so what is being made is visible before it exists.
    await type(nameField(host)!, `changelog`);
    expect(draft!.textContent).toContain(`changelog`);
});

test(`a refused save keeps the editor and what was typed, and says why beside Save`, async () => {
    skills.value = [skill({ id: `notes`, name: `notes` })];
    saveMutate.mockRejectedValueOnce(new Error(`disk is full`));
    const host = mount();

    rows(host)[0]?.click();
    await settle();
    const trigger = host.querySelector<HTMLTextAreaElement>(`textarea`)!;
    trigger.value = `Use when the user asks for meeting notes.`;
    trigger.dispatchEvent(new Event(`input`));
    await nextTick();

    button(host, `Save changes`)?.click();
    await settle();
    expect(saveMutate).toHaveBeenCalledWith(expect.objectContaining({ name: `notes`, description: `Use when the user asks for meeting notes.` }));
    expect(host.textContent).toContain(`disk is full`);
    expect(rows(host)[0]?.getAttribute(`aria-expanded`)).toBe(`true`);
});

// A rewrite with nothing changed has nothing to send.
test(`Save changes rests until something changed`, async () => {
    skills.value = [skill({ id: `notes`, name: `notes` })];
    const host = mount();

    rows(host)[0]?.click();
    await settle();
    expect(button(host, `Save changes`)?.hasAttribute(`disabled`)).toBe(true);
});
