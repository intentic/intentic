// Pins which rows the Subagents list draws for a chip-filtered agent, and which facts appear on a child's row.
// Needs jsdom: mounts a real Vue app to the DOM.
import "@intentic/testing/dom";
import { humanizeModelId, type SubagentSession } from "@intentic/sandbox-contract";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { IconStub } from "@intentic/ui/testing";
import * as vueQueryOriginal from "@tanstack/vue-query";
import * as subagentsQueryOriginal from "./subagentsQuery";

const child = (over: Partial<SubagentSession>): SubagentSession => ({
    id: `call-1`,
    kind: `subagent`,
    conversationId: `c1`,
    agentType: `Explore`,
    description: `Locate the handler`,
    status: `running`,
    startedAt: 1,
    activityAt: 1,
    ...over,
});

const sessions = ref<SubagentSession[]>([]);
// Why the roster read failed, and the transcript read's rejection, as each query reports it.
const rosterError = ref<string | undefined>(undefined);
const transcriptError = ref<Error | null>(null);
// Conversation ids the page pointed the docked chat at.
const opened: string[] = [];

// Stubs the roster/fleet caches so the test drives the list, not the network; `subagentLive` stays real.
jest.mock("./subagentsQuery", () => ({
    ...subagentsQueryOriginal,
    useSubagentsQuery: () => ({
        sessions: computed(() => sessions.value),
        running: computed(() => sessions.value),
        error: computed(() => rosterError.value),
        refetch: async () => undefined,
    }),
}));
jest.mock("../../agents/fleet/useAgents", () => ({
    useAgents: () => ({
        agentById: (id: string) => (id === `c1` ? { id, title: `analyse the gap`, model: `x-test-model` } : undefined),
        open: (agent: { id: string }) => void opened.push(agent.id),
    }),
}));
// Stubs useQuery (the transcript read); irrelevant to which rows the rail draws.
jest.mock("@tanstack/vue-query", () => ({
    ...vueQueryOriginal,
    useQuery: () => ({ data: ref(undefined), error: transcriptError }),
}));

const { default: Subagents } = await import("./Subagents.vue");

// Scoped router avoids the app's auth redirect, which would masquerade as an unfiltered list.
const routerFor = async (query: Record<string, string>): Promise<Router> => {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: `/subagents/:id?`, name: `subagents`, component: defineComponent({ render: () => h(`div`) }) },
            // Fallback route for "Parent" when the roster hasn't seen it yet; a known parent opens the dock instead.
            { path: `/agents/:id?`, name: `agents`, component: defineComponent({ render: () => h(`div`) }) },
        ],
    });
    await router.push({ name: `subagents`, query });
    await router.isReady();
    return router;
};

let app: App | undefined;
let mounted: Router | undefined;
const mount = async (query: Record<string, string>): Promise<HTMLElement> => {
    const router = await routerFor(query);
    mounted = router;
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(Subagents) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.mount(el);
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    mounted = undefined;
    document.body.innerHTML = ``;
    sessions.value = [];
    rosterError.value = undefined;
    transcriptError.value = null;
    opened.length = 0;
});

it(`shows one agent's children when the card's chip named it`, async () => {
    sessions.value = [child({}), child({ id: `call-2`, conversationId: `c2`, description: `Audit the deps` })];
    const text = (await mount({ agent: `c1` })).textContent ?? ``;
    expect(text).toContain(`Locate the handler`);
    expect(text).not.toContain(`Audit the deps`);
});

it(`says so when the named agent's children have aged out, rather than claiming it never delegated`, async () => {
    sessions.value = [child({ id: `call-2`, conversationId: `c2`, description: `Audit the deps` })];
    const el = await mount({ agent: `c1` });
    const text = el.textContent ?? ``;
    expect(text).toContain(`analyse the gap`);
    expect(text).not.toContain(`No agents started`);
    expect([...el.querySelectorAll(`a`)].some((link) => link.textContent?.includes(`Show every agent`))).toBe(true);
});

it(`lists every child when nothing narrowed it`, async () => {
    sessions.value = [child({}), child({ id: `call-2`, conversationId: `c2`, description: `Audit the deps` })];
    const text = (await mount({})).textContent ?? ``;
    expect(text).toContain(`Locate the handler`);
    expect(text).toContain(`Audit the deps`);
});

it(`opens the parent conversation in the chat instead of leaving for its diff`, async () => {
    sessions.value = [child({})];
    const el = await mount({});
    const parent = [...el.querySelectorAll(`a`)].find((link) => link.textContent?.includes(`Parent`));
    expect(parent?.getAttribute(`href`)).toBe(`/agents/c1`);
    parent?.click();
    await nextTick();
    expect(opened).toEqual([`c1`]);
    expect(mounted?.currentRoute.value.name).toBe(`subagents`);
});

// The spawning call named no model, so the row falls back to the parent's inherited model, named as every surface names it.
it(`names the model on the card and drops the facts that crowded it out`, async () => {
    sessions.value = [child({ background: true, toolUses: 6, tokens: 19_000 })];
    const card = (await mount({})).querySelector(`.session-card`);
    const text = card?.textContent ?? ``;
    expect(text).toContain(`Locate the handler`);
    expect(text).toContain(humanizeModelId(`x-test-model`));
    expect(text).not.toContain(`bg`);
    expect(text).not.toContain(`Explore`);
    expect(text).not.toContain(`analyse the gap`);
    expect(text).not.toContain(`19k`);
});

// `sonnet` is a tier with no catalog entry, so it renders as the capitalized word, not a version.
it(`names the child's own model rather than the conversation's`, async () => {
    sessions.value = [child({ model: `sonnet` })];
    const text = (await mount({})).querySelector(`.session-card`)?.textContent ?? ``;
    expect(text).toContain(`Sonnet`);
    expect(text).not.toContain(humanizeModelId(`x-test-model`));
});

// Hidden is the default, so the control's label reads "Show tool calls".
it(`offers the chat's tool-call control, and no composer`, async () => {
    sessions.value = [child({})];
    const el = await mount({});
    expect(el.querySelector(`[aria-label="Show tool calls"]`)).not.toBeNull();
    expect(el.querySelector(`textarea`)).toBeNull();
});

it(`says why the roster could not be read, rather than claiming no agent was ever started`, async () => {
    rosterError.value = `Request failed (503).`;
    const text = (await mount({})).textContent ?? ``;
    expect(text).toContain(`Request failed (503).`);
    expect(text).not.toContain(`No agents started`);
});

it(`says why a finished child's transcript could not be read, rather than claiming none was recorded`, async () => {
    sessions.value = [child({ status: `completed` })];
    transcriptError.value = new Error(`The session store is unreadable.`);
    const text = (await mount({})).textContent ?? ``;
    expect(text).toContain(`The session store is unreadable.`);
    expect(text).not.toContain(`No transcript was recorded for this agent.`);
});
