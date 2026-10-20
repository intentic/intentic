import "@intentic/testing/dom";
import { createApp, h, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { registerView } from "../../workbench/views/registry";
import { sandboxSections } from "../../models/sandbox/sandboxNav";
import { settingsSections } from "../../features/settings/settingsNav";
import { startAppI18n } from "../../app/i18n";
import { commands } from "../../workbench/commands/useCommands";
import { useNavigationCommands } from "./useNavigationCommands";

// Pins the promise this composable exists for: everywhere the shell can take you is reachable by name, derived from
// the same tables the rail and the hubs draw, and nothing is offered that the surface would bounce the reader off.

// The section tables name themselves through `t`, so without the app's own catalog every title below is the raw key.
// main.ts awaits this before mounting; so does this file, for the same reason.
await startAppI18n();

// Read inside the mock factories, so a test can set the grant and the plan before mounting.
const state = { canShip: true, planOffered: true };

jest.mock(`../../models/extensions/usePanels`, () => {
    return { usePanels: () => ({ panels: ref([]), allPanels: ref([]), isLoading: ref(false), loaded: ref({ state: `ready`, data: {}, refreshing: false, refreshError: undefined }) }) };
});
jest.mock(`../../models/capabilities/useCapabilities`, () => {
    return { useCapabilities: () => ({ capabilities: ref([]), loaded: ref({ state: `ready`, data: {}, refreshing: false, refreshError: undefined }) }) };
});
jest.mock(`../../client/sandbox/useRole`, () => {
    return { useRole: () => ({ canShip: ref(state.canShip), isGuest: ref(false) }) };
});
jest.mock(`../../models/hosted-plan/useHostedPlan`, () => {
    return { useHostedPlan: () => ({ offered: ref(state.planOffered) }) };
});

const mountShell = (): { unmount: () => void } => {
    const app = createApp({
        setup() {
            useNavigationCommands();
            return () => h(`div`);
        },
    });
    // Only used inside handlers (router.push), so one catch-all route covers the whole dependency.
    app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: `/:all(.*)*`, component: { render: () => null } }] }));
    app.mount(document.createElement(`div`));
    return app;
};

const ids = (): readonly string[] => commands.value.map((entry) => entry.command);

afterEach(() => {
    state.canShip = true;
    state.planOffered = true;
});

it(`registers one destination per sandbox section and per settings section`, () => {
    const app = mountShell();

    for (const section of sandboxSections(true)) {
        expect(ids(), `Sandbox ▸ ${section.label} has no command`).toContain(`view.sandbox.${section.slug}`);
    }
    for (const section of settingsSections(true)) {
        expect(ids(), `Settings ▸ ${section.label} has no command`).toContain(`view.settings.${section.slug}`);
    }
    // A page drawn at the foot of another keeps its own name: "Voice" still finds the wake word.
    expect(commands.value.find((entry) => entry.command === `view.settings.voice`)).toMatchObject({ category: `Settings`, title: `Voice` });
    app.unmount();
});

it(`names each destination by its family, so the palette groups them`, () => {
    const app = mountShell();

    expect(commands.value.find((entry) => entry.command === `view.sandbox.secrets`)).toMatchObject({ category: `Sandbox`, title: `Secrets` });
    expect(commands.value.find((entry) => entry.command === `view.settings.appearance`)).toMatchObject({ category: `Settings`, title: `Appearance` });
    expect(commands.value.find((entry) => entry.command === `view.agents`)).toMatchObject({ category: `Go to`, title: `Agents` });
    app.unmount();
});

it(`offers the areas whose rail tiles come and go with what is running`, () => {
    const app = mountShell();

    // Browsers leaves the rail when nothing is running; the palette is the way back to a finished one.
    expect(ids()).toEqual(expect.arrayContaining([`view.browsers`, `view.chat`, `view.preview`, `view.capabilities`]));
    // The desktop has no evidence to tile it by, so its tile waits in More; the palette names it for a maintainer.
    expect(ids()).toContain(`view.desktop`);
    expect(ids()).not.toContain(`view.subagents`);
    app.unmount();
});

it(`withholds what this reader's grant and plan would bounce them off`, () => {
    state.canShip = false;
    state.planOffered = false;
    const app = mountShell();

    // The sandbox hub hides these rows below maintainer, and Billing until a plan is sold; an offered command would
    // land on a section that redirects away.
    expect(ids()).not.toContain(`view.sandbox.secrets`);
    expect(ids()).not.toContain(`view.sandbox.devices`);
    // The daemon opens the sandbox's desktop to a maintainer only.
    expect(ids()).not.toContain(`view.desktop`);
    expect(ids()).not.toContain(`view.settings.billing`);
    // Everything ungated is still there.
    expect(ids()).toContain(`view.sandbox.overview`);
    expect(ids()).toContain(`view.settings.profile`);
    app.unmount();
});

it(`follows an extension onto the sandbox hub`, () => {
    // A `sandbox`-surface view is a hub section, not a rail tile: it earns a "Sandbox: …" destination like a built-in.
    const view = registerView(`ext-logs`, {
        id: `logs`,
        label: `Logs`,
        surface: `sandbox`,
        detect: () => [{ key: `logs`, title: `Logs`, icon: `file` }],
        view: async () => ({}) as never,
    });
    const app = mountShell();

    expect(commands.value.find((entry) => entry.command === `view.sandbox.logs`)).toMatchObject({ category: `Sandbox`, title: `Logs` });
    app.unmount();
    view.dispose();
});

it(`gives Activity's name to the sandbox's own section, never to an extension's view`, () => {
    // Activity is a built-in section that draws the Activity extension's turns inside it; a view under the same key, a
    // stranger's or that extension's own, would open as if it were the sandbox's record, beside the audit trail Activity
    // holds, so it earns no destination of its own.
    // SAFETY: the palette never loads a view's component, so an empty module stands in for one.
    const stranger = { id: `activity`, label: `Activity`, surface: `sandbox` as const, view: async () => ({}) as never };
    const impostor = registerView(`someone.activity`, { ...stranger, detect: () => [{ key: `activity`, title: `Not the record`, icon: `file` }] });
    const own = registerView(`intentic.activity`, { ...stranger, detect: () => [{ key: `activity`, title: `Turns`, icon: `wave-pulse` }] });
    const app = mountShell();
    const activity = commands.value.filter((entry) => entry.command === `view.sandbox.activity`);
    expect(activity).toHaveLength(1);
    expect(activity[0]?.title).not.toBe(`Not the record`);
    expect(activity[0]?.title).not.toBe(`Turns`);
    app.unmount();
    impostor.dispose();
    own.dispose();
});

it(`names every page a tabbed row stands for, and the audit trail inside Activity, at an address that lands on it`, () => {
    // Privacy & safety is one row in the hub, and the audit log a part of Activity; a reader who knows the page they want
    // types its name rather than browsing for its row.
    const app = mountShell();
    for (const [slug, title] of [
        [`privacy-shield`, `Privacy shield`],
        [`guardrails`, `Guardrails`],
        [`retention`, `Retention`],
        [`audit`, `Audit log`],
    ] as const) {
        expect(commands.value.find((entry) => entry.command === `view.sandbox.${slug}`)).toMatchObject({ category: `Sandbox`, title });
    }
    expect(ids()).not.toContain(`view.sandbox.privacy`);
    app.unmount();
});

it(`releases every command when the shell goes away`, () => {
    const app = mountShell();
    expect(ids().length).toBeGreaterThan(10);

    app.unmount();
    expect(commands.value).toHaveLength(0);
});
