// The switcher a scope chip opens. It replaced a flat menu of every conversation that ever had a branch, so what is
// pinned here is what that menu could not do: say where the reader is, keep a long lane short, find a copy by typing.
import "@intentic/testing/dom";
import type { ViewScope } from "../../../app/workspaceScope";
import type { FleetAgent } from "../../../models/fleet/useAgents-fleet";
import type { BranchChoice } from "./scopeChoices";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

const NONE = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const copy = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    title: `Conversation ${id}`,
    status: `landed`,
    provider: `claude`,
    harness: `claude-code`,
    branch: `agent/${id}`,
    updatedAt: 10_000,
    attention: NONE,
    open: false,
    unread: false,
    unsent: false,
    ...over,
});

const fleet = ref<FleetAgent[]>([]);
jest.mock(`../../../models/fleet/useAgents`, () => ({
    useAgents: () => ({ fleet, agentById: (id: string) => fleet.value.find((agent) => agent.id === id) }),
}));

// Each repository's branches as the list reads them once it opens; none unless a test names some.
const branches = ref<BranchChoice[]>([]);
jest.mock(`./useBranchChoices`, () => ({ useBranchChoices: () => ({ choices: branches, loading: ref(false) }) }));

const { default: WorkspaceScopePicker } = await import("./WorkspaceScopePicker.vue");

let app: App | undefined;
const picked: ViewScope[] = [];
const mount = async (current: ViewScope, props: Record<string, unknown> = {}): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: `/:rest(.*)*`, component: { render: () => null } }] });
    app = createApp({ render: () => h(WorkspaceScopePicker, { current, onPick: (picks: ViewScope) => picked.push(picks), ...props }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.mount(el);
    await nextTick();
    await nextTick();
    return el;
};

const options = (el: HTMLElement): string[] => [...el.querySelectorAll(`[role=option]`)].map((row) => row.textContent?.trim() ?? ``);
const buttonSaying = (el: HTMLElement, text: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(text));

beforeAll(() => {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    fleet.value = [];
    branches.value = [];
    picked.length = 0;
    document.body.innerHTML = ``;
});

it(`marks the copy on screen, and offers the shared tree first`, async () => {
    fleet.value = [copy(`a`, { title: `Pipeline blocks` }), copy(`b`, { title: `Push button changes` })];
    const el = await mount({ agent: `b` });

    expect(options(el)[0]).toContain(`Shared workspace`);
    const selected = el.querySelector(`[role=option][aria-selected=true]`);
    expect(selected?.textContent).toContain(`Push button changes`);
    buttonSaying(el, `Shared workspace`)?.click();
    expect(picked).toEqual([{}]);
});

it(`folds a long lane, and unfolds it on a press`, async () => {
    fleet.value = Array.from({ length: 20 }, (_, i) => copy(`f${i}`, { updatedAt: 10_000 - i }));
    const el = await mount({ agent: `f0` });

    // The shared row and the lane's latest six.
    expect(options(el)).toHaveLength(7);
    buttonSaying(el, `Show 14 more`)?.click();
    await nextTick();
    expect(options(el)).toHaveLength(21);
});

it(`finds a folded copy by typing, and Enter switches to it`, async () => {
    fleet.value = [
        ...Array.from({ length: 20 }, (_, i) => copy(`f${i}`, { updatedAt: 10_000 - i })),
        copy(`old`, { title: `Workspace changes view`, updatedAt: 1 }),
    ];
    const el = await mount({ agent: `f0` });
    const search = el.querySelector(`input`);
    if (search === null) {
        throw new Error(`the switcher drew no search field`);
    }

    search.value = `changes view`;
    search.dispatchEvent(new Event(`input`));
    await nextTick();
    expect(options(el)).toEqual([expect.stringContaining(`Workspace changes view`)]);
    search.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    expect(picked).toEqual([{ agent: `old` }]);
});

it(`offers the review of the copy on screen, and nothing to review from the shared tree`, async () => {
    fleet.value = [copy(`a`)];

    expect((await mount({ agent: `a` })).querySelector(`a[href="/agents/a"]`)).not.toBeNull();
    app?.unmount();
    expect((await mount({})).querySelector(`a[href^="/agents/"]`)).toBeNull();
});

it(`lists each repository's branches under the shared row, and a press views that branch`, async () => {
    fleet.value = [copy(`a`, { title: `Pipeline blocks` })];
    branches.value = [
        { repo: `root`, branch: `feature/login`, at: 9_000 },
        { repo: `root`, branch: `fix/typo`, at: 8_000, remote: `origin` },
    ];
    const el = await mount({}, { mainLine: `main` });

    expect(options(el).slice(0, 3)).toEqual([expect.stringContaining(`main`), expect.stringContaining(`feature/login`), expect.stringContaining(`fix/typo`)]);
    expect(options(el)[2]).toContain(`origin`);
    buttonSaying(el, `feature/login`)?.click();
    expect(picked).toEqual([{ repo: `root`, branch: `feature/login` }]);
});

it(`marks the branch on screen, and says what stays on the shared workspace`, async () => {
    branches.value = [{ repo: `apps/web`, branch: `next`, at: 1 }];
    const el = await mount({ repo: `apps/web`, branch: `next` });

    expect(el.querySelector(`[role=option][aria-selected=true]`)?.textContent).toContain(`next`);
    expect(el.textContent).toContain(`Search, terminals and previews use the shared workspace.`);
    // A branch has no card to review.
    expect(el.querySelector(`a[href^="/agents/"]`)).toBeNull();
});

it(`offers to start from the main line, a branch, or a copy a fresh session can be cut from`, async () => {
    fleet.value = [copy(`here`, { title: `Copy here` }), copy(`laptop`, { title: `On a runner`, runner: `laptop` })];
    branches.value = [{ repo: `root`, branch: `next`, at: 1 }];
    const el = await mount({}, { purpose: `start` });

    expect(options(el)[0]).toContain(`Main line`);
    expect(el.textContent).toContain(`Copy here`);
    expect(el.textContent).not.toContain(`On a runner`);
    expect(el.textContent).not.toContain(`stay on the shared workspace`);
});

