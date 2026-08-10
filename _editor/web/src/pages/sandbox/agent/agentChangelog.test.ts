// @vitest-environment jsdom
//
// THE ONE CLAIM: a repo keeps a changelog only because somebody said so, per repo, and the switch writes exactly
// that. Everything downstream of this setting — whether the commit drafter asks for a `Release-Note:` line at
// all — reads the list this component writes, and the daemon runs on the user's own repositories, so a switch
// that wrote the wrong name (or wrote every name) would turn a convention on in somebody else's project.
//
// Mounted rather than projected, on the same reasoning as agentRules.test.ts next door: what is under test is
// the round trip a person performs — press the switch, read what the settings object now holds.
import type { SandboxSettings } from "@intentic-app/api-contract";
import { SandboxSettingsSchema } from "@intentic-app/api-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, computed, createApp, defineComponent, h, ref } from "vue";

// Same app-wide singletons the sibling test stands in for — read at import time, before any test runs.
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

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = vi.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

vi.mock(`../../../composables/sandbox/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

// A workspace with a second repo in it, because the per-repo half of this is the half worth proving: one row
// must not write the other's name.
vi.mock(`../../../composables/workspace/useRepos`, () => ({
    useRepos: () => ({
        options: computed(() => [`root`, `vendor/widget`]),
        nested: computed(() => [`vendor/widget`]),
        repoDirs: computed(() => new Set([`vendor/widget`])),
        refresh: () => undefined,
    }),
}));

const { default: AgentChangelog } = await import("./AgentChangelog.vue");

let app: App | undefined;

const mount = (component: unknown): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(component as never) });
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
    settings.value = SandboxSettingsSchema.parse({});
    patch.mockClear();
});

const toggleAt = (host: HTMLElement, index: number): HTMLElement => {
    const switches = [...host.querySelectorAll(`[role="switch"], input[type="checkbox"]`)];
    const control = switches[index];
    expect(control, `expected a switch at index ${index}`).toBeDefined();
    return control as HTMLElement;
};

test(`every repo starts off — nothing changes in anybody's repository until they ask for it`, () => {
    const host = mount(AgentChangelog);
    expect(settings.value.changelogRepos).toEqual([]);
    // One row per repo, "root" first.
    expect(host.querySelectorAll(`[role="switch"], input[type="checkbox"]`)).toHaveLength(2);
});

test(`switching a repo on names that repo and only that repo`, async () => {
    const host = mount(AgentChangelog);

    toggleAt(host, 1).click();
    await Promise.resolve();

    expect(settings.value.changelogRepos).toEqual([`vendor/widget`]);
});

test(`a second repo joins the first rather than replacing it`, async () => {
    settings.value = { ...settings.value, changelogRepos: [`root`] };
    const host = mount(AgentChangelog);

    toggleAt(host, 1).click();
    await Promise.resolve();

    expect(settings.value.changelogRepos).toEqual([`root`, `vendor/widget`]);
});

test(`switching one off leaves the others alone`, async () => {
    settings.value = { ...settings.value, changelogRepos: [`root`, `vendor/widget`] };
    const host = mount(AgentChangelog);

    toggleAt(host, 0).click();
    await Promise.resolve();

    expect(settings.value.changelogRepos).toEqual([`vendor/widget`]);
});
