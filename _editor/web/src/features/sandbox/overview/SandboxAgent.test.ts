// @vitest-environment jsdom
// Pins which groups render in which category, and how the `section`/`connect` query params interact.
// jsdom: mounts the component tree and reads rendered DOM.
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { IconStub } from "@intentic/ui/testing";

// Settings already loaded and sandbox reachable, so the blocked notice never renders.
vi.mock(`../client/useSandbox`, () => ({ useSandbox: () => ({ reachable: ref(true) }) }));
vi.mock(`./useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings: ref({}), error: ref(undefined), dropped: ref(undefined), patch: async () => undefined }),
}));

// vi.mock calls are hoisted, so each specifier must be a literal string; can't loop over the group list.
const stub = (name: string) => ({ default: defineComponent({ render: () => h(`section`, { "data-group": name }) }) });
vi.mock(`../secrets/AiAccountSection.vue`, () => stub(`AI account`));
vi.mock(`../agent-settings/models/AgentModels.vue`, () => stub(`Models`));
vi.mock(`../agent-settings/skills/AgentInstructions.vue`, () => stub(`Instructions`));
vi.mock(`../agent-settings/skills/AgentSkills.vue`, () => stub(`Skills`));
vi.mock(`../agent-settings/safety/AgentRules.vue`, () => stub(`Rules`));
vi.mock(`../agent-settings/skills/AgentMemory.vue`, () => stub(`Memory`));
vi.mock(`../agent-settings/behaviour/AgentCodeSearch.vue`, () => stub(`Code search`));
vi.mock(`../agent-settings/behaviour/AgentDependencies.vue`, () => stub(`Dependencies`));
vi.mock(`../agent-settings/behaviour/AgentCommandOutput.vue`, () => stub(`Command output`));
vi.mock(`../agent-settings/behaviour/AgentSubagents.vue`, () => stub(`Subagents`));
vi.mock(`../agent-settings/behaviour/AgentRecovery.vue`, () => stub(`When a turn breaks`));
vi.mock(`../agent-settings/safety/AgentSafetyJudge.vue`, () => stub(`Safety judge`));
vi.mock(`../agent-settings/safety/AgentSafetyPolicy.vue`, () => stub(`Safety policy`));
vi.mock(`../agent-settings/safety/AgentSafetyLog.vue`, () => stub(`Recent decisions`));
vi.mock(`../agent-settings/behaviour/AgentChecks.vue`, () => stub(`Checks`));
vi.mock(`../agent-settings/behaviour/AgentFinishedWork.vue`, () => stub(`Finished work`));
vi.mock(`../agent-settings/behaviour/AgentChangelog.vue`, () => stub(`Changelog`));

// Categories the strip offers; the coverage test walks this array instead of a hand-copied list.
const EVERY_SECTION = [`models`, `instructions`, `tools`, `safety`, `finishing`];

// Every group name, used to check each lands in exactly one category.
const EVERY_GROUP = [
    `AI account`,
    `Models`,
    `Instructions`,
    `Skills`,
    `Rules`,
    `Memory`,
    `Code search`,
    `Dependencies`,
    `Command output`,
    `Subagents`,
    `When a turn breaks`,
    `Safety judge`,
    `Safety policy`,
    `Recent decisions`,
    `Checks`,
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

it(`opens on the models category alone`, async () => {
    const { el } = await mount();
    expect(shown(el)).toEqual([`AI account`, `Models`]);
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
    expect(shown(el)).not.toContain(`AI account`);
});

it(`falls back to models when the address names a category that does not exist`, async () => {
    const { el } = await mount({ section: `nonsense` });
    expect(shown(el)).toEqual([`AI account`, `Models`]);
});

it(`opens the safety category with the gate rules alone`, async () => {
    const { el } = await mount({ section: `safety` });
    expect(shown(el)).toEqual([`Safety judge`, `Safety policy`, `Recent decisions`]);
});

it(`holds delegation under tools, not under the gate rules`, async () => {
    const { el } = await mount({ section: `tools` });
    expect(shown(el)).toEqual([`Code search`, `Dependencies`, `Command output`, `Subagents`]);
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;

    const { el: safety } = await mount({ section: `safety` });
    expect(shown(safety)).toEqual([`Safety judge`, `Safety policy`, `Recent decisions`]);
});

it(`shows accounts for a sign-in link even while another category is named`, async () => {
    const { el } = await mount({ section: `finishing`, connect: `anthropic` });
    expect(shown(el)).toContain(`AI account`);
    expect(shown(el)).not.toContain(`Checks`);
});

// Waits for the navigation, not a render tick, since the strip reads its category back off the address.
it(`writes the picked category to the address, and the default writes no param`, async () => {
    const { el, router } = await mount();
    pill(el, `Finishing`).click();
    await vi.waitFor(() => expect(router.currentRoute.value.query[`section`]).toBe(`finishing`));
    expect(shown(el)).toEqual([`Checks`, `Finished work`, `Changelog`, `When a turn breaks`]);

    pill(el, `Models`).click();
    await vi.waitFor(() => expect(router.currentRoute.value.query[`section`]).toBeUndefined());
    expect(shown(el)).toEqual([`AI account`, `Models`]);
});

it(`lets a pill escape a sign-in link`, async () => {
    const { el, router } = await mount({ connect: `anthropic` });
    pill(el, `Instructions`).click();
    await vi.waitFor(() => expect(router.currentRoute.value.query[`connect`]).toBeUndefined());
    expect(shown(el)).toEqual([`Instructions`, `Skills`, `Rules`, `Memory`]);
});
