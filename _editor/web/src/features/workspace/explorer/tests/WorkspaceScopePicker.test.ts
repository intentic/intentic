// The switcher a scope chip opens. It replaced a flat menu of every conversation that ever had a branch, so what is
// pinned here is what that menu could not do: say where the reader is, keep a long lane short, find a copy by typing.
import "@intentic/testing/dom";
import type { FleetAgent } from "../../../agents/fleet/useAgents-fleet";
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
jest.mock(`../../../agents/fleet/useAgents`, () => ({
    useAgents: () => ({ fleet, agentById: (id: string) => fleet.value.find((agent) => agent.id === id) }),
}));

const { default: WorkspaceScopePicker } = await import("../WorkspaceScopePicker.vue");

let app: App | undefined;
const picked: (string | undefined)[] = [];
const mount = async (current: string | undefined): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: `/:rest(.*)*`, component: { render: () => null } }] });
    app = createApp({ render: () => h(WorkspaceScopePicker, { current, onPick: (agent: string | undefined) => picked.push(agent) }) });
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
    picked.length = 0;
    document.body.innerHTML = ``;
});

it(`marks the copy on screen, and offers the shared tree first`, async () => {
    fleet.value = [copy(`a`, { title: `Pipeline blocks` }), copy(`b`, { title: `Push button changes` })];
    const el = await mount(`b`);

    expect(options(el)[0]).toContain(`Shared workspace`);
    const selected = el.querySelector(`[role=option][aria-selected=true]`);
    expect(selected?.textContent).toContain(`Push button changes`);
    buttonSaying(el, `Shared workspace`)?.click();
    expect(picked).toEqual([undefined]);
});

it(`folds a long lane, and unfolds it on a press`, async () => {
    fleet.value = Array.from({ length: 20 }, (_, i) => copy(`f${i}`, { updatedAt: 10_000 - i }));
    const el = await mount(`f0`);

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
    const el = await mount(`f0`);
    const search = el.querySelector(`input`);
    if (search === null) {
        throw new Error(`the switcher drew no search field`);
    }

    search.value = `changes view`;
    search.dispatchEvent(new Event(`input`));
    await nextTick();
    expect(options(el)).toEqual([expect.stringContaining(`Workspace changes view`)]);
    search.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    expect(picked).toEqual([`old`]);
});

it(`offers the review of the copy on screen, and nothing to review from the shared tree`, async () => {
    fleet.value = [copy(`a`)];

    expect((await mount(`a`)).querySelector(`a[href="/agents/a"]`)).not.toBeNull();
    app?.unmount();
    expect((await mount(undefined)).querySelector(`a[href^="/agents/"]`)).toBeNull();
});
