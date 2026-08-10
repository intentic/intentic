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
// Mounted rather than projected because the controls ARE the subject, and the switch's write happens in the
// component's own handler.
import type { SandboxSettings, SkillSummary } from "@intentic-app/api-contract";
import { SandboxSettingsSchema } from "@intentic-app/api-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";

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
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
});

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
        readBody: async () => ({ id: `x`, name: `x`, body: `Body.` }),
        forgetBody: vi.fn(),
    }),
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
test(`a switched-off skill still gets a row, dimmed and switchable`, () => {
    skills.value = [skill({ id: `lsp`, name: `lsp`, origin: `builtin`, enabled: false, editable: false, removable: false })];
    const host = mount();

    expect(host.textContent).toContain(`lsp`);
    expect(switches(host)).toHaveLength(1);
    expect(host.querySelector(`.opacity-60`)).not.toBeNull();
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
