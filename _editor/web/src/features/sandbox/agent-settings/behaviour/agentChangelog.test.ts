// @vitest-environment jsdom
// Pins that toggling a repo's changelog switch writes exactly that repo's name to `changelogRepos`, never
// another. Mounted (not projected), since what's under test is the click-then-read round trip.
import type { SandboxSettings } from "@intentic/api-contract";
import { SandboxSettingsSchema } from "@intentic/api-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, computed, createApp, h, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = vi.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

vi.mock(`../../overview/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

// Two repos, since the per-repo half is what's worth proving: one row must not write the other's name.
vi.mock(`../../../workspace/explorer/useRepos`, () => ({
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
    app.component(`Icon`, IconStub);
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
    expect(control, `expected a switch at index ${index}`).toEqual(expect.any(Object));
    return control as HTMLElement;
};

test(`every repo starts off: nothing changes in anybody's repository until they ask for it`, () => {
    const host = mount(AgentChangelog);
    expect(settings.value.changelogRepos).toEqual([]);
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
