// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, h } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { registerView } from "../../core-views/registry";
import { sandboxSections } from "../../features/sandbox/sandboxNav";
import { settingsSections } from "../../features/settings/settingsNav";
import { startAppI18n } from "../../app/i18n";
import { commands } from "./useCommands";
import { useNavigationCommands } from "./useNavigationCommands";

// Pins the promise this composable exists for: everywhere the shell can take you is reachable by name, derived from
// the same tables the rail and the hubs draw, and nothing is offered that the surface would bounce the reader off.

// The section tables name themselves through `t`, so without the app's own catalog every title below is the raw key.
// main.ts awaits this before mounting; so does this file, for the same reason.
await startAppI18n();

// Read inside the mock factories, so a test can set the grant and the plan before mounting.
const state = vi.hoisted(() => ({ canShip: true, planOffered: true }));

vi.mock(`../../features/extensions/usePanels`, async () => {
    const { ref } = await import(`vue`);
    return { usePanels: () => ({ panels: ref([]), allPanels: ref([]), isLoading: ref(false), settled: ref(true) }) };
});
vi.mock(`../../features/capabilities/connect/useCapabilities`, async () => {
    const { ref } = await import(`vue`);
    return { useCapabilities: () => ({ capabilities: ref([]), settled: ref(true) }) };
});
vi.mock(`../../features/sandbox/secrets/useRole`, async () => {
    const { ref } = await import(`vue`);
    return { useRole: () => ({ canShip: ref(state.canShip), isGuest: ref(false) }) };
});
vi.mock(`../../features/settings/hosted-plan/useHostedPlan`, async () => {
    const { ref } = await import(`vue`);
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

    // Browsers and Subagents leave the rail when nothing is running; the palette is the way back to a finished one.
    expect(ids()).toEqual(expect.arrayContaining([`view.browsers`, `view.subagents`, `view.chat`, `view.preview`, `view.capabilities`]));
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

it(`releases every command when the shell goes away`, () => {
    const app = mountShell();
    expect(ids().length).toBeGreaterThan(10);

    app.unmount();
    expect(commands.value).toHaveLength(0);
});
