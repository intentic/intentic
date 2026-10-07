// Pins which groups render in which category, how the `section` query param picks one, and that an old `connect` link
// is forwarded to Sandbox ▸ Models, where accounts live now.
// jsdom: mounts the component tree and reads rendered DOM.
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { type App, createApp, defineComponent, h, ref } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { IconStub } from "@intentic/ui/testing";

// Settings already loaded and sandbox reachable, so the blocked notice never renders.
jest.mock(`../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ reachable: ref(true) }) }));
jest.mock(`./useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings: ref({}), error: ref(undefined), dropped: ref(undefined), patch: async () => undefined }),
}));

// A mock.module specifier must be a literal string, so the group list cannot be looped over.
const stub = (name: string) => ({ default: defineComponent({ render: () => h(`section`, { "data-group": name }) }) });
jest.mock(`../agent-settings/models/AgentModels.vue`, () => stub(`Jobs`));
jest.mock(`../agent-settings/skills/AgentInstructions.vue`, () => stub(`Instructions`));
jest.mock(`../agent-settings/skills/AgentSkills.vue`, () => stub(`Skills`));
jest.mock(`../agent-settings/skills/AgentMemory.vue`, () => stub(`Memory`));
jest.mock(`../agent-settings/skills/AgentMemoryImport.vue`, () => stub(`Memory import`));
jest.mock(`../agent-settings/behaviour/AgentCodeSearch.vue`, () => stub(`Code search`));
jest.mock(`../agent-settings/behaviour/AgentRepoChecks.vue`, () => stub(`Checks after edits`));
jest.mock(`../agent-settings/behaviour/AgentCommandOutput.vue`, () => stub(`Command output`));
jest.mock(`../agent-settings/behaviour/AgentSubagents.vue`, () => stub(`Subagents`));
jest.mock(`../agent-settings/behaviour/AgentOffload.vue`, () => stub(`Where heavy work runs`));
jest.mock(`../agent-settings/behaviour/AgentRecovery.vue`, () => stub(`When a turn breaks`));
jest.mock(`../agent-settings/safety/AgentSafetyJudge.vue`, () => stub(`Safety judge`));
jest.mock(`../agent-settings/safety/AgentProjectInstalls.vue`, () => stub(`Project installs`));
jest.mock(`../agent-settings/safety/AgentSafetyPolicy.vue`, () => stub(`Safety policy`));
jest.mock(`../agent-settings/safety/AgentPrivacyShield.vue`, () => stub(`Privacy shield`));
jest.mock(`../agent-settings/safety/AgentSafetyLog.vue`, () => stub(`Recent decisions`));
jest.mock(`../agent-settings/behaviour/AgentChecks.vue`, () => stub(`After work lands`));
jest.mock(`../agent-settings/behaviour/AgentFinishedWork.vue`, () => stub(`Finished work`));
jest.mock(`../agent-settings/behaviour/AgentChangelog.vue`, () => stub(`Changelog`));

// Categories the strip offers; the coverage test walks this array instead of a hand-copied list.
const EVERY_SECTION = [`jobs`, `instructions`, `tools`, `safety`, `finishing`];

// Every group name, used to check each lands in exactly one category.
const EVERY_GROUP = [
    `Jobs`,
    `Instructions`,
    `Skills`,
    `Memory`,
    `Memory import`,
    `Code search`,
    `Checks after edits`,
    `Command output`,
    `Subagents`,
    `Where heavy work runs`,
    `When a turn breaks`,
    `Safety judge`,
    `Project installs`,
    `Safety policy`,
    `Privacy shield`,
    `Recent decisions`,
    `After work lands`,
    `Finished work`,
    `Changelog`,
];

const { default: SandboxAgent } = await import("./SandboxAgent.vue");

// Bare route with no auth guards, so a redirect can't be mistaken for a default category.
const routerFor = async (query: Record<string, string>): Promise<Router> => {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: `/sandbox/:tab?`, name: `sandbox`, component: defineComponent({ render: () => h(`div`) }) }],
    });
    await router.push({ name: `sandbox`, params: { tab: `agent` }, query });
    await router.isReady();
    return router;
};

let app: App | undefined;
const mount = async (query: Record<string, string> = {}): Promise<{ el: HTMLElement; router: Router }> => {
    const router = await routerFor(query);
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxAgent) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.mount(el);
    return { el, router };
};

const shown = (el: HTMLElement): string[] => [...el.querySelectorAll(`[data-group]`)].map((node) => node.getAttribute(`data-group`)!);
const pill = (el: HTMLElement, label: string): HTMLButtonElement =>
    [...el.querySelectorAll<HTMLButtonElement>(`button[role="tab"]`)].find((button) => button.textContent?.trim() === label)!;

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`opens on the jobs category alone, and holds no accounts`, async () => {
    const { el } = await mount();
    expect(shown(el)).toEqual([`Jobs`]);
    // The way to what the jobs choose among, since the accounts are not on this tab any more.
    expect(el.querySelector(`a[href="/sandbox/models"]`)).not.toBeNull();
});

it(`puts each group in exactly one category`, async () => {
    const seen: string[] = [];
    for (const section of EVERY_SECTION) {
        const { el } = await mount({ section });
        seen.push(...shown(el));
        app?.unmount();
        app = undefined;
        document.body.innerHTML = ``;
    }
    expect(seen).toEqual([...new Set(seen)]);
    expect(seen.toSorted()).toEqual(EVERY_GROUP.toSorted());
});

it(`opens the category a link named`, async () => {
    const { el } = await mount({ section: `tools` });
    expect(shown(el)).toContain(`Code search`);
    expect(shown(el)).not.toContain(`Jobs`);
});

it(`falls back to jobs when the address names a category that does not exist`, async () => {
    const { el } = await mount({ section: `nonsense` });
    expect(shown(el)).toEqual([`Jobs`]);
});

// Links written before the category was named for what it holds.
it(`opens jobs for the category's old name`, async () => {
    const { el } = await mount({ section: `models` });
    expect(shown(el)).toEqual([`Jobs`]);
});

it(`opens the safety category with the gate rules alone`, async () => {
    const { el } = await mount({ section: `safety` });
    expect(shown(el)).toEqual([`Safety judge`, `Project installs`, `Safety policy`, `Privacy shield`, `Recent decisions`]);
});

it(`holds delegation under tools, not under the gate rules`, async () => {
    const { el } = await mount({ section: `tools` });
    expect(shown(el)).toEqual([`Code search`, `Checks after edits`, `Command output`, `Subagents`, `Where heavy work runs`]);
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;

    const { el: safety } = await mount({ section: `safety` });
    expect(shown(safety)).toEqual([`Safety judge`, `Project installs`, `Safety policy`, `Privacy shield`, `Recent decisions`]);
});

// `?connect=` opened a provider's accounts here when they lived on this tab; a link from then lands on them now.
it(`forwards an old sign-in link to Sandbox ▸ Models, naming the same provider`, async () => {
    const { router } = await mount({ section: `finishing`, connect: `claude` });
    await waitFor(() => expect(router.currentRoute.value.path).toBe(`/sandbox/models`));
    expect(router.currentRoute.value.query).toEqual({ provider: `claude` });
});

// Waits for the navigation, not a render tick, since the strip reads its category back off the address.
it(`writes the picked category to the address, and the default writes no param`, async () => {
    const { el, router } = await mount();
    pill(el, `Finishing`).click();
    await waitFor(() => expect(router.currentRoute.value.query[`section`]).toBe(`finishing`));
    expect(shown(el)).toEqual([`After work lands`, `Finished work`, `Changelog`, `When a turn breaks`]);

    pill(el, `Jobs`).click();
    await waitFor(() => expect(router.currentRoute.value.query[`section`]).toBeUndefined());
    expect(shown(el)).toEqual([`Jobs`]);
});
