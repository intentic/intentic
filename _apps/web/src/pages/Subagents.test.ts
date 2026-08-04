// @vitest-environment jsdom
//
// jsdom because the subject is WHICH ROWS ARE DRAWN. The list itself is the daemon's, sorted and filtered
// nowhere else; what this pins is the narrowing the card's chip asks for — a chip is a claim about one agent
// ("this one started five"), and following it into every child the sandbox has ever spawned makes the reader
// redo the filtering the click already expressed.
//
// The second case is the one the lifetime count created. A card counts children for the agent's whole life,
// while this list holds a finished child for minutes — so a chip followed an hour later lands on an empty rail,
// and "No agents started" would flatly contradict the number that was just clicked.
import type { SubagentSession } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, computed, createApp, defineComponent, h, ref } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";

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

// The roster and the fleet, which the page reads through their shared caches — stood in for here so the test
// drives the LIST, not the network. `subagentLive` stays real: the lanes' split is the daemon's own rule.
vi.mock("../composables/subagents/subagentsQuery", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../composables/subagents/subagentsQuery")>()),
    useSubagentsQuery: () => ({ sessions: computed(() => sessions.value), running: computed(() => sessions.value), refetch: async () => undefined }),
}));
vi.mock("../composables/agents/useAgents", () => ({
    useAgents: () => ({ agentById: (id: string) => (id === `c1` ? { id, title: `analyse the gap` } : undefined) }),
}));
// The selected child's transcript — a network read with nothing to say about which rows the rail draws. Only
// useQuery is stood in for: the app's own query client is built from the rest of this module at import time.
vi.mock("@tanstack/vue-query", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@tanstack/vue-query")>()),
    useQuery: () => ({ data: ref([]) }),
}));

const { default: Subagents } = await import("./Subagents.vue");

// A router holding just this route: the app's own carries the guards that send an unauthenticated visitor to
// setup, and a redirected test reads as an unfiltered list — which is precisely the bug it would be pinning.
const routerFor = async (query: Record<string, string>): Promise<Router> => {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: `/subagents/:id?`, name: `subagents`, component: defineComponent({ render: () => h(`div`) }) },
            // The selected child's "Parent" link resolves against this — a route the page links to but never
            // follows here, and an unresolvable link warns on every render.
            { path: `/agents/:id?`, name: `agents`, component: defineComponent({ render: () => h(`div`) }) },
        ],
    });
    await router.push({ name: `subagents`, query });
    await router.isReady();
    return router;
};

let app: App | undefined;
const mount = async (query: Record<string, string>): Promise<HTMLElement> => {
    const router = await routerFor(query);
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(Subagents) });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    app.directive(`tooltip`, {});
    app.use(router);
    app.mount(el);
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    sessions.value = [];
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
    // And the way back out of a filtered rail, which is the whole reason the empty state is not a dead end.
    expect([...el.querySelectorAll(`a`)].some((link) => link.textContent?.includes(`Show every agent`))).toBe(true);
});

it(`lists every child when nothing narrowed it`, async () => {
    sessions.value = [child({}), child({ id: `call-2`, conversationId: `c2`, description: `Audit the deps` })];
    const text = (await mount({})).textContent ?? ``;
    expect(text).toContain(`Locate the handler`);
    expect(text).toContain(`Audit the deps`);
});
