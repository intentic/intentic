// One skill as a page. The reader's own is written where it is read and survives the tab being switched away; anybody
// else's reads as its document, beside the facts the list had no room for, and a file of a folder the agent reads is asked
// for as that workspace file. What becomes of the tab holding it is its host's: the page reports, it never reaches in.
import "@intentic/testing/dom";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import { type SandboxSettings, type SkillBody, type SkillSummary, SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import PrimeVue from "primevue/config";
import { stubGlobal } from "@intentic/testing/bun";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// BrandMark fetches a mark from an icon CDN; stubbed to fail like an offline sandbox, falling to the glyph tier.
stubGlobal(`fetch`, () => Promise.resolve({ ok: false, text: () => Promise.resolve(``) }));

const skills = ref<SkillSummary[]>([]);
const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const body = ref<SkillBody | undefined>();
const saveMutate = jest.fn();
const removeMutate = jest.fn();
const setEnabled = jest.fn();
const openFile = jest.fn();
const gone = jest.fn();
const saved = jest.fn();
const edited = jest.fn();
const invalidateQueries = jest.fn(async () => undefined);

const ready = <T,>(data: T) => ({ state: `ready` as const, data, refreshing: false, refreshError: undefined });

jest.mock(`../../environment/useSkills`, () => ({
    useSkills: () => ({
        skills,
        settings,
        loaded: computed(() => ready([skills.value, settings.value])),
        save: { mutateAsync: saveMutate, isPending: ref(false) },
        remove: { mutate: removeMutate },
        setEnabled,
    }),
}));
jest.mock(`../../../../client/sandbox/useSandboxQuery`, () => ({
    useSandboxQuery: () => ({ query: { data: body }, loaded: computed(() => ready(body.value)) }),
}));
const vueQuery = await import(`@tanstack/vue-query`);
jest.mock(`@tanstack/vue-query`, () => ({ ...vueQuery, useQueryClient: () => ({ invalidateQueries }) }));
jest.mock(`vue-router`, () => ({
    useRouter: () => ({ push: jest.fn() }),
    RouterLink: defineComponent({ props: { to: { type: [String, Object], required: true } }, setup: (_, { slots }) => () => h(`a`, {}, slots[`default`]?.()) }),
}));
jest.mock(`../../../../models/capabilities/useCapabilities`, () => ({ useCapabilities: () => ({ capabilities: ref<CapabilitySummary[]>([]) }) }));
jest.mock(`../../../../models/extensions/useExtensions`, () => ({ useExtensions: () => ({ enabled: ref<ExtensionSummary[]>([]) }) }));

const { default: SkillPage } = await import("./SkillPage.vue");
const { dropDraft, heldDraft, holdDraft, NEW_SKILL } = await import("./skillDrafts");

const own = (over: Partial<SkillSummary> = {}): SkillSummary => ({
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

const mount = (skill: string, name = skill): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(SkillPage, { skill, name, onGone: gone, onSaved: saved, onEdited: edited, onOpenFile: openFile }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

const unmount = (): void => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
};

afterEach(() => {
    unmount();
    skills.value = [];
    body.value = undefined;
    for (const fn of [saveMutate, removeMutate, setEnabled, openFile, gone, saved, edited, invalidateQueries]) {
        fn.mockClear();
    }
    saveMutate.mockReset();
    dropDraft(`notes`);
    dropDraft(NEW_SKILL);
});

const button = (host: HTMLElement, label: string): HTMLElement | undefined =>
    [...host.querySelectorAll<HTMLElement>(`button`)].find((element) => element.textContent?.trim() === label);
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};
const typeInto = async (field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
    field.value = value;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
};

test(`somebody else's skill reads as its document, beside how often turns reach for it, its size, and where it came from`, async () => {
    skills.value = [
        own({ id: `unsloppify`, name: `unsloppify`, origin: `dropped`, switchable: false, editable: false, uses: { week: 3, last: new Date().toISOString() } }),
    ];
    body.value = { id: `unsloppify`, name: `unsloppify`, body: `# unsloppify\n\nState the plain version.`, folder: `.agents/skills/unsloppify`, files: [`references/patterns.md`] };
    const host = mount(`unsloppify`);
    await settle();
    expect(host.querySelector(`h1`)?.textContent).toContain(`unsloppify`);
    expect(host.textContent).toContain(`State the plain version.`);
    expect(host.textContent).toContain(`3 turns this week`);
    expect(host.textContent).toContain(`5 words`);
    expect(host.textContent).toContain(`Loose file`);
    // Nothing to type into: it is not the reader's to rewrite here.
    expect(host.querySelector(`textarea`)).toBeNull();
});

test(`a file of a folder the agent reads is asked for as that workspace file, SKILL.md first`, async () => {
    skills.value = [own({ id: `unsloppify`, name: `unsloppify`, origin: `dropped`, switchable: false, editable: false })];
    body.value = { id: `unsloppify`, name: `unsloppify`, body: `Body.`, folder: `.agents/skills/unsloppify`, files: [`references/patterns.md`, `scripts/scan.sh`] };
    const host = mount(`unsloppify`);
    await settle();
    button(host, `SKILL.md`)?.click();
    button(host, `scripts/scan.sh`)?.click();
    expect(openFile.mock.calls).toEqual([[`.agents/skills/unsloppify/SKILL.md`], [`.agents/skills/unsloppify/scripts/scan.sh`]]);
});

test(`a folder outside the workspace lists its files without offering to open them`, async () => {
    skills.value = [own({ id: `extension:pack:review`, name: `review`, origin: `extension`, owner: `pack`, switchable: false, editable: false, removable: false })];
    body.value = { id: `extension:pack:review`, name: `review`, body: `Body.`, files: [`checklist.md`] };
    const host = mount(`extension:pack:review`, `review`);
    await settle();
    expect(host.textContent).toContain(`checklist.md`);
    expect(button(host, `checklist.md`)).toBeUndefined();
    expect(button(host, `SKILL.md`)).toBeUndefined();
});

test(`a loose file deletes from its facts, on a second press, and says it is gone`, async () => {
    skills.value = [own({ id: `scratch`, name: `scratch`, origin: `dropped`, switchable: false, editable: false })];
    body.value = { id: `scratch`, name: `scratch`, body: `Body.`, folder: `.agents/skills/scratch`, files: [] };
    const host = mount(`scratch`);
    await settle();
    button(host, `Delete this skill`)?.click();
    await nextTick();
    expect(removeMutate).not.toHaveBeenCalled();
    button(host, `Delete`)?.click();
    expect(removeMutate).toHaveBeenCalledWith(`scratch`);
    expect(gone).toHaveBeenCalledTimes(1);
});

test(`the reader's own skill is written where it is read, and what was typed outlives the tab being switched away`, async () => {
    skills.value = [own()];
    body.value = { id: `notes`, name: `notes`, body: `Take notes.`, files: [] };
    const first = mount(`notes`);
    await settle();
    expect(button(first, `Save changes`)?.hasAttribute(`disabled`)).toBe(true);
    await typeInto(first.querySelector(`textarea`)!, `Use when the user asks for meeting notes.`);
    expect(heldDraft(`notes`)?.description).toBe(`Use when the user asks for meeting notes.`);
    // Said once, so a host that replaces what it shows on the next open keeps this one.
    expect(edited).toHaveBeenCalledTimes(1);
    unmount();

    // Another tab was picked and this one picked again: the page mounts afresh, on what was typed.
    const again = mount(`notes`);
    await settle();
    expect(again.querySelector<HTMLTextAreaElement>(`textarea`)?.value).toBe(`Use when the user asks for meeting notes.`);
    button(again, `Save changes`)?.click();
    await settle();
    expect(saveMutate).toHaveBeenCalledWith({ name: `notes`, description: `Use when the user asks for meeting notes.`, body: `Take notes.` });
    expect(heldDraft(`notes`)).toBeUndefined();
});

test(`a refused save keeps what was typed and says why beside Save`, async () => {
    skills.value = [own()];
    body.value = { id: `notes`, name: `notes`, body: `Take notes.`, files: [] };
    saveMutate.mockRejectedValueOnce(new Error(`disk is full`));
    const host = mount(`notes`);
    await settle();
    await typeInto(host.querySelector(`textarea`)!, `Use when the user asks for meeting notes.`);
    button(host, `Save changes`)?.click();
    await settle();
    expect(host.textContent).toContain(`disk is full`);
    expect(host.querySelector<HTMLTextAreaElement>(`textarea`)?.value).toBe(`Use when the user asks for meeting notes.`);
    expect(heldDraft(`notes`)).toMatchObject({ description: `Use when the user asks for meeting notes.` });
});

test(`Cancel on a rewrite puts the saved text back`, async () => {
    skills.value = [own()];
    body.value = { id: `notes`, name: `notes`, body: `Take notes.`, files: [] };
    const host = mount(`notes`);
    await settle();
    await typeInto(host.querySelector(`textarea`)!, `Something else entirely.`);
    button(host, `Cancel`)?.click();
    await settle();
    expect(host.querySelector<HTMLTextAreaElement>(`textarea`)?.value).toBe(`Use when the user asks for notes.`);
    expect(heldDraft(`notes`)).toBeUndefined();
});

test(`pressing Add skill on an empty page names each missing field and saves nothing`, async () => {
    const host = mount(NEW_SKILL, `New skill`);
    await settle();
    button(host, `Add skill`)?.click();
    await nextTick();
    expect(saveMutate).not.toHaveBeenCalled();
    expect(host.textContent).toContain(`Give it a name.`);
    expect(host.textContent).toContain(`Say when the agent should reach for it.`);
    expect(host.textContent).toContain(`Write what it should do.`);
});

test(`a new skill can't take a name already in the list`, async () => {
    skills.value = [own()];
    const host = mount(NEW_SKILL, `New skill`);
    await settle();
    await typeInto(host.querySelector<HTMLInputElement>(`input.font-mono`)!, `notes`);
    expect(host.textContent).toContain(`There's already a skill called notes.`);
});

test(`a new skill's page says which skill it became once saved`, async () => {
    holdDraft(NEW_SKILL, { name: `changelog`, description: `Use when asked for a changelog.`, body: `Group by Added, Changed, Fixed.` });
    const host = mount(NEW_SKILL, `New skill`);
    await settle();
    // The head follows the name, so what is being made is visible before it exists.
    expect(host.querySelector(`h1`)?.textContent).toContain(`changelog`);
    button(host, `Add skill`)?.click();
    await settle();
    expect(saveMutate).toHaveBeenCalledWith({ name: `changelog`, description: `Use when asked for a changelog.`, body: `Group by Added, Changed, Fixed.` });
    expect(saved).toHaveBeenCalledWith(`changelog`);
    expect(heldDraft(NEW_SKILL)).toBeUndefined();
});

test(`a skill gone since its tab opened says so rather than drawing a blank page`, async () => {
    skills.value = [];
    body.value = { id: `notes`, name: `notes`, body: ``, files: [] };
    const host = mount(`notes`);
    await settle();
    expect(host.textContent).toContain(`notes isn't here any more.`);
});
