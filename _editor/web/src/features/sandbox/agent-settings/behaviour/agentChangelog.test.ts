// Pins that pressing a repo's changelog chip writes exactly that repo's name to `changelogRepos`, never
// another. Mounted (not projected), since what's under test is the click-then-read round trip.
import "@intentic/testing/dom";
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = jest.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

jest.mock(`../../../../models/sandbox/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

// Two repos, since the per-repo half is what's worth proving: one row must not write the other's name.
jest.mock(`../../../../models/workspace/tree/useRepos`, () => ({
    useRepos: () => ({
        options: computed(() => [`root`, `vendor/widget`, `extensions/a`, `extensions/b`]),
        nested: computed(() => [`vendor/widget`]),
        repoDirs: computed(() => new Set([`vendor/widget`])),
        refresh: () => undefined,
    }),
}));

const { default: AgentChangelog } = await import("./AgentChangelog.vue");
const { changelogLanes } = await import("./agentChangelog");

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
    const chips = [...host.querySelectorAll(`button[aria-pressed]`)];
    const control = chips[index];
    expect(control, `expected a chip at index ${index}`).toEqual(expect.any(Object));
    return control as HTMLElement;
};

test(`every repo starts off: nothing changes in anybody's repository until they ask for it`, () => {
    const host = mount(AgentChangelog);
    expect(settings.value.changelogRepos).toEqual([]);
    const chips = [...host.querySelectorAll(`button[aria-pressed]`)];
    expect(chips).toHaveLength(4);
    expect(chips.every((chip) => chip.getAttribute(`aria-pressed`) === `false`)).toBe(true);
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

test(`the summary counts only repos that are here, so a stale name can't inflate it`, async () => {
    settings.value = { ...settings.value, changelogRepos: [`root`, `gone/repo`] };
    const host = mount(AgentChangelog);
    expect(host.textContent).toContain(`On in 1 of 4 repositories.`);
});

test(`a folder of several repos is said once over them; a folder of one joins the top lane whole`, () => {
    const lanes = changelogLanes([`root`, `vendor/widget`, `extensions/a`, `intentic`, `extensions/b`], `Workspace`);
    expect(lanes).toEqual([
        {
            folder: undefined,
            chips: [
                { repo: `root`, name: `Workspace` },
                { repo: `vendor/widget`, name: `vendor/widget` },
                { repo: `intentic`, name: `intentic` },
            ],
        },
        {
            folder: `extensions/`,
            chips: [
                { repo: `extensions/a`, name: `a` },
                { repo: `extensions/b`, name: `b` },
            ],
        },
    ]);
});
