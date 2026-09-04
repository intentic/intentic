// @vitest-environment jsdom
//
// jsdom because the subject is WHICH GROUPS ARE ON SCREEN. The Agent tab used to stack seventeen sections in one
// scroll; it now shows one category of them at a time, and everything worth pinning is about the seam between
// the strip and the address:
//
//   · the category has to survive a reload and a shared link, because several places already link into this page
//     aimed at ONE setting: the composer's connect gate, its "turn it off for every chat" link, and Usage's
//     experiment cards. A link that lands on a category not holding what it promised is worse than the long
//     scroll it replaced.
//   · a `?connect=` sign-in link has to win over a remembered category, and pressing a pill has to be able to
//     get out from under it again: otherwise the strip reads as dead.
//
// None of that can be read off the template, and the last one is the failure the two params can produce between
// them.
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";

// The page's whole world: a settings read that has landed (so nothing renders the blocked notice) and a sandbox
// that answers. What this file is about is the strip above them, not what any group does with the object.
vi.mock(`../../composables/sandbox/useSandbox`, () => ({ useSandbox: () => ({ reachable: ref(true) }) }));
vi.mock(`../../composables/sandbox/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings: ref({}), error: ref(undefined), dropped: ref(undefined), patch: async () => undefined }),
}));

// Every group stood in for by its own name, because the assertion IS the name: each real one opens a daemon read
// of its own, and mounting thirteen of them would test the network rather than the split. Written out one call
// per group rather than looped: vi.mock is hoisted, so its specifier has to be a literal.
const stub = (name: string) => ({ default: defineComponent({ render: () => h(`section`, { "data-group": name }) }) });
vi.mock(`./AiAccountSection.vue`, () => stub(`AI account`));
vi.mock(`./agent/AgentModels.vue`, () => stub(`Models`));
vi.mock(`./agent/AgentInstructions.vue`, () => stub(`Instructions`));
vi.mock(`./agent/AgentSkills.vue`, () => stub(`Skills`));
vi.mock(`./agent/AgentRules.vue`, () => stub(`Rules`));
vi.mock(`./agent/AgentMemory.vue`, () => stub(`Memory`));
vi.mock(`./agent/AgentCodeSearch.vue`, () => stub(`Code search`));
vi.mock(`./agent/AgentDependencies.vue`, () => stub(`Dependencies`));
vi.mock(`./agent/AgentCommandOutput.vue`, () => stub(`Command output`));
vi.mock(`./agent/AgentSubagents.vue`, () => stub(`Subagents`));
vi.mock(`./agent/AgentRecovery.vue`, () => stub(`When a turn breaks`));
vi.mock(`./agent/AgentSafetyJudge.vue`, () => stub(`Safety judge`));
vi.mock(`./agent/AgentSafetyPolicy.vue`, () => stub(`Safety policy`));
vi.mock(`./agent/AgentSafetyLog.vue`, () => stub(`Recent decisions`));
vi.mock(`./agent/AgentChecks.vue`, () => stub(`Checks`));
vi.mock(`./agent/AgentFinishedWork.vue`, () => stub(`Finished work`));
vi.mock(`./agent/AgentChangelog.vue`, () => stub(`Changelog`));

// Every category the strip offers, in the order it draws them: the coverage test walks this rather than a
// transcribed copy, so a category added without groups fails here instead of quietly holding nothing.
const EVERY_SECTION = [`models`, `instructions`, `tools`, `safety`, `finishing`];

// The seventeen names above, for the test that every one of them lands in exactly one category.
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

// The hub's route, alone: the app's own carries guards that would redirect an unauthenticated visitor, and a
// redirected test reads as a page showing its default category: precisely the thing half of these check.
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
    app.component(`Icon`, defineComponent({ props: { name: String, spin: Boolean }, render: () => h(`i`) }));
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

/* The default, and the reason the split is worth anything: fifteen of the seventeen groups are NOT on the page.
 *
 * MODELS IS THE DEFAULT rather than a category named for the accounts it leads with. Signing in is a step toward
 * picking a model, never the errand itself, and `/sandbox/agent#models` — the composer's "turn it off for every
 * chat" link — is a bare fragment with no query behind it, so the group carrying that anchor has to be the one a
 * paramless address draws. */
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

// A link that names a category, end to end: the category opens and the setting it promised is drawn.
it(`opens the category a link named`, async () => {
    const { el } = await mount({ section: `tools` });
    expect(shown(el)).toContain(`Code search`);
    expect(shown(el)).not.toContain(`AI account`);
});

// A stale or hand-typed name lands on the default rather than on a page with nothing on it: there is no row in
// the strip to get back from a blank one.
it(`falls back to models when the address names a category that does not exist`, async () => {
    const { el } = await mount({ section: `nonsense` });
    expect(shown(el)).toEqual([`AI account`, `Models`]);
});

/* Safety is the one category whose groups write the daemon's own gates rather than a preference, and it is
 * reached by the same address the other four are. Pinned separately from the coverage test above because a
 * `v-else-if` chain that fell through would put its groups on the FINISHING page (the chain's `v-else`) rather
 * than nowhere, and a coverage assertion counting names cannot tell those two apart. */
it(`opens the safety category with the gate rules alone`, async () => {
    const { el } = await mount({ section: `safety` });
    // Standing rules and controls first, followed by the decision log.
    expect(shown(el)).toEqual([`Safety judge`, `Safety policy`, `Recent decisions`]);
});

/* DELEGATION IS ONE GROUP ON ONE CATEGORY, which is the whole reason Tools exists under that name. Whether a
 * turn may start agents of its own was a group called "Child agents" under Safety, while the numbers bounding
 * them were a group called "Subagents" one category away: one concept, two names, two screens. Both halves are
 * now rows of Subagents (agentSubagents.test.ts holds that), so what this pins is the category they landed in —
 * a coverage assertion counting names would pass just as happily with the switch back under the gate rules. */
it(`holds delegation under tools, not under the gate rules`, async () => {
    const { el } = await mount({ section: `tools` });
    // Both categories in full rather than a membership check: the group has to be ON one screen and OFF the
    // other, and a `toContain` pair would still pass with Subagents drawn on both.
    expect(shown(el)).toEqual([`Code search`, `Dependencies`, `Command output`, `Subagents`]);
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;

    const { el: safety } = await mount({ section: `safety` });
    expect(shown(safety)).toEqual([`Safety judge`, `Safety policy`, `Recent decisions`]);
});

// The composer's connect gate wins over whatever the address last remembered: it is a request to sign an account
// in, and the group that does that leads Models.
it(`shows accounts for a sign-in link even while another category is named`, async () => {
    const { el } = await mount({ section: `finishing`, connect: `anthropic` });
    expect(shown(el)).toContain(`AI account`);
    expect(shown(el)).not.toContain(`Checks`);
});

// A press navigates, so the assertions wait for the navigation rather than for a render tick: the strip writes
// the address and reads the page back off it, which is the whole reason a reload keeps the category.
it(`writes the picked category to the address, and the default writes no param`, async () => {
    const { el, router } = await mount();
    pill(el, `Finishing`).click();
    await vi.waitFor(() => expect(router.currentRoute.value.query[`section`]).toBe(`finishing`));
    // Checks are here rather than beside the search tool because this is when they run: work is proved, then it
    // reaches the user, then the exception — the turn that broke instead — comes last.
    expect(shown(el)).toEqual([`Checks`, `Finished work`, `Changelog`, `When a turn breaks`]);

    pill(el, `Models`).click();
    await vi.waitFor(() => expect(router.currentRoute.value.query[`section`]).toBeUndefined());
    expect(shown(el)).toEqual([`AI account`, `Models`]);
});

// The seam between the two params. Without dropping `connect`, the sign-in link would keep pulling the page back
// to Accounts and every other pill would look broken.
it(`lets a pill escape a sign-in link`, async () => {
    const { el, router } = await mount({ connect: `anthropic` });
    pill(el, `Instructions`).click();
    await vi.waitFor(() => expect(router.currentRoute.value.query[`connect`]).toBeUndefined());
    expect(shown(el)).toEqual([`Instructions`, `Skills`, `Rules`, `Memory`]);
});
