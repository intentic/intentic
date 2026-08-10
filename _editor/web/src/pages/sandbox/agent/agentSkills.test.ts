// @vitest-environment jsdom
//
// THE CLAIM THIS GROUP RESTS ON: a row offers only what its origin can honour. Every control is drawn from what
// the daemon said about that row — never from a rule restated in the component — because a switch that appeared to
// work and was undone by the next reconcile is worse than no switch, and a delete that silently came back is worse
// still. So what is under test is the mapping from six origins to the controls each one gets.
//
// The second claim is completeness: this list exists to answer "what is my agent carrying", which is only worth
// asking if the answer includes the things nobody remembers adding — a plugin's skills, a connection's cheatsheet,
// a file the agent wrote itself, and a built-in that is currently switched OFF.
//
// The third is that reading one is the ROW'S OWN CLICK. It used to be a hamburger, a two-item menu, and a text
// Close button at the foot of what opened; the menu items said nothing the row didn't imply, and nothing on a
// closed row said which of them even had one. Pinned here because it is the kind of affordance that grows back.
//
// Mounted rather than projected because the controls ARE the subject, and the switch's write happens in the
// component's own handler.
import type { CapabilitySummary, SandboxSettings, SkillSummary } from "@intentic-app/api-contract";
import { SandboxSettingsSchema } from "@intentic-app/api-contract";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// These components' import chain pulls in app-wide singletons that read browser globals at import time
// (@intentic/ui's useDevice reads window.matchMedia; environment.ts reads window.env).
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        analytics: { posthogKey: ``, posthogHost: `` },
        auth: { googleClientId: `` },
    };
});

// A row's mark is fetched from an icon CDN (<BrandMark>), which a test has no business reaching. Answered as a
// miss, which is the same path an offline sandbox takes — the glyph tier underneath.
vi.stubGlobal(`fetch`, () => Promise.resolve({ ok: false, text: () => Promise.resolve(``) }));

const skills = ref<SkillSummary[]>([]);
const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const setEnabled = vi.fn();
const removeMutate = vi.fn();

vi.mock(`../../../composables/sandbox/useSkills`, () => ({
    useSkills: () => ({
        skills,
        settings,
        error: ref(undefined),
        isLoading: ref(false),
        save: { mutate: vi.fn() },
        remove: { mutate: removeMutate },
        setEnabled,
        readBody: async () => ({ id: `x`, name: `x`, body: `## Body.` }),
        forgetBody: vi.fn(),
    }),
}));

// The two lists the marks are joined against. Empty here: what each tier does with them is skillVisual's own
// test, and this file is about the controls.
vi.mock(`../../../composables/extensions/useCapabilities`, () => ({
    useCapabilities: () => ({ capabilities: ref<CapabilitySummary[]>([]) }),
}));
vi.mock(`../../../composables/extensions/useExtensions`, () => ({
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
    // Icon and v-tooltip are registered app-wide by installUi; stand-ins keep this off the whole UI plugin
    // (the rules group's convention). PrimeVue goes on bare — its inputs read the injected config while
    // rendering — without the theme the app dresses it in, which this test has no opinion about.
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
    skills.value = [];
    settings.value = SandboxSettingsSchema.parse({});
    setEnabled.mockClear();
    removeMutate.mockClear();
});

const switches = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll(`[role="switch"], input[type="checkbox"]`)] as HTMLElement[];
// The row's own header button — the one gesture that opens a skill.
const rows = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll(`button[aria-expanded]`)] as HTMLElement[];
const button = (host: HTMLElement, label: string): HTMLElement | undefined =>
    [...host.querySelectorAll(`button`)].find((element) => element.textContent?.trim() === label);
// The body arrives from a fetch, so opening a row settles a promise before it renders.
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

test(`the switch appears only on rows the daemon said are switchable, and writes the skill's name`, async () => {
    skills.value = [
        skill({ id: `notes`, name: `notes` }),
        skill({ id: `lsp`, name: `lsp`, origin: `builtin`, editable: false, removable: false }),
        // Everything below is on because something else is on — a switch here could not honour a click.
        skill({ id: `plugin:pack:review`, name: `review`, origin: `plugin`, owner: `pack`, switchable: false, editable: false, removable: false }),
        skill({ id: `github`, name: `github`, origin: `capability`, owner: `github`, switchable: false, editable: false, removable: false }),
    ];
    const host = mount();

    expect(switches(host)).toHaveLength(2);
    switches(host)[0]?.click();
    await Promise.resolve();
    // The NAME, not the id: the enabled list is keyed by what the loader calls the skill.
    expect(setEnabled).toHaveBeenCalledWith(`notes`, false);
});

/* A BUILT-IN THAT IS OFF IS THE ONE ROW HERE THAT IS NOT LOADED, and it has to be drawn anyway: hiding it is
 * exactly what once made `lsp` undiscoverable — never declined, just never learned about. */
test(`a switched-off skill still gets a row, drained and switchable`, () => {
    skills.value = [skill({ id: `lsp`, name: `lsp`, origin: `builtin`, enabled: false, editable: false, removable: false })];
    const host = mount();

    expect(host.textContent).toContain(`lsp`);
    expect(switches(host)).toHaveLength(1);
    // <BrandMark idle> — the mark goes grey, which says the same thing to someone who cannot see the colour.
    expect(host.querySelector(`.grayscale`)).not.toBeNull();
});

/* The provenance chip is the column the whole list is for: "Plugin · pack" tells the reader which of their plugins
 * to go and look at, and a bare "Plugin" does not.
 *
 * It is also ALL a row says about provenance. Each origin used to carry a sentence here as well ("Remove the plugin
 * to drop it."), which read as the same line four times down one group and pushed most rows onto two lines — so
 * what a kind lets you do moved into the group's (i), where it is read once. */
test(`each row names where it came from, with its owner when it has one`, () => {
    skills.value = [
        skill({ id: `plugin:pack:review`, name: `review`, origin: `plugin`, owner: `pack`, switchable: false, editable: false, removable: false }),
        skill({ id: `scratch`, name: `scratch`, origin: `dropped`, switchable: false, editable: false, removable: true }),
    ];
    const host = mount();

    expect(host.textContent).toContain(`Plugin · pack`);
    expect(host.textContent).toContain(`Loose file`);
    expect(host.textContent).not.toContain(`Remove the plugin`);
});

// A skill with no description is a skill the agent will almost never pick, and nothing else on screen would say so.
test(`a missing description is called out rather than left blank`, () => {
    skills.value = [skill({ description: `` })];
    expect(mount().textContent).toContain(`No description`);
});

test(`an empty list invites the first skill rather than reading as a failure`, () => {
    const host = mount();
    expect(host.textContent).toContain(`No skills yet`);
    expect(host.textContent).toContain(`Write a skill`);
});

/* ONE CLICK OPENS IT, THE SAME CLICK CLOSES IT, and there is no menu in between. The row is the control — which
 * also means the reader's own skill lands straight in the editor, since for them reading and editing are one
 * errand. */
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

/* SOMEBODY ELSE'S SKILL IS A DOCUMENT, not a grey monospace block — a skill is markdown, and rendering it as
 * source said the opposite of what it is. The file itself stays one pill away. */
test(`a skill the owner can't edit opens as its own prose, with the raw file one pill away`, async () => {
    skills.value = [skill({ id: `scratch`, name: `scratch`, origin: `dropped`, switchable: false, editable: false })];
    const host = mount();

    rows(host)[0]?.click();
    await settle();
    expect(host.querySelector(`.md-prose`)?.innerHTML).toContain(`<h2`);
    expect(button(host, `Source`)).not.toBeUndefined();
});

/* DELETE ASKS FIRST, AND ONLY WHERE THE ROW SAID IT COULD. It used to sit one keystroke deep in a menu on the
 * closed row, where a mis-click cost whatever the reader had written; now it is beside the text it would remove. */
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
