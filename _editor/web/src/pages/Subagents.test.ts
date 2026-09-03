// @vitest-environment jsdom
//
// jsdom because the subject is WHICH ROWS ARE DRAWN, AND WHAT EACH ONE SAYS. The list itself is the daemon's,
// sorted and filtered nowhere else; what this pins is the narrowing the card's chip asks for: a chip is a claim
// about one agent ("this one started five"), and following it into every child the sandbox has ever spawned
// makes the reader redo the filtering the click already expressed.
//
// The second case is the one the lifetime count created. A card counts children for the agent's whole life,
// while this list holds a finished child for minutes, so a chip followed an hour later lands on an empty rail,
// and "No agents started" would flatly contradict the number that was just clicked.
//
// The last two are about the CARD's line of facts, which is a switcher's line and had grown into a dashboard's:
// the model, the one fact that decides whether a delegation is worth opening, was the one it left out, behind
// four that never decided anything. Pinned because that line is a shared shape rather than this page's own
// taste: it is the floating chat's rail card carrying other rows.
import type { SubagentSession } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";

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
// Which conversations the page pointed the docked chat at: the whole of what "Parent" is supposed to do.
const opened: string[] = [];

// The roster and the fleet, which the page reads through their shared caches: stood in for here so the test
// drives the LIST, not the network. `subagentLive` stays real: the lanes' split is the daemon's own rule.
vi.mock("../composables/subagents/subagentsQuery", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../composables/subagents/subagentsQuery")>()),
    useSubagentsQuery: () => ({ sessions: computed(() => sessions.value), running: computed(() => sessions.value), refetch: async () => undefined }),
}));
// The parent carries a MODEL, because that is what a child inheriting one inherits: an SDK subagent runs inside
// its parent's turn, and the daemon only learns the child's own model from a meta file read when its transcript
// is opened, so the parent's entry is what answers "which model is that child burning" while it is still running.
vi.mock("../composables/agents/useAgents", () => ({
    useAgents: () => ({
        agentById: (id: string) => (id === `c1` ? { id, title: `analyse the gap`, model: `x-test-model` } : undefined),
        open: (agent: { id: string }) => void opened.push(agent.id),
    }),
}));
// The selected child's transcript: a network read with nothing to say about which rows the rail draws. Only
// useQuery is stood in for: the app's own query client is built from the rest of this module at import time.
vi.mock("@tanstack/vue-query", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@tanstack/vue-query")>()),
    useQuery: () => ({ data: ref([]) }),
}));

const { default: Subagents } = await import("./Subagents.vue");

// A router holding just this route: the app's own carries the guards that send an unauthenticated visitor to
// setup, and a redirected test reads as an unfiltered list, which is precisely the bug it would be pinning.
const routerFor = async (query: Record<string, string>): Promise<Router> => {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: `/subagents/:id?`, name: `subagents`, component: defineComponent({ render: () => h(`div`) }) },
            // Where "Parent" falls back to when the roster has never heard of the parent: on a desktop that
            // knows it, the press points the dock instead and this page stays put.
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
    mounted = undefined;
    document.body.innerHTML = ``;
    sessions.value = [];
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
    // And the way back out of a filtered rail, which is the whole reason the empty state is not a dead end.
    expect([...el.querySelectorAll(`a`)].some((link) => link.textContent?.includes(`Show every agent`))).toBe(true);
});

it(`lists every child when nothing narrowed it`, async () => {
    sessions.value = [child({}), child({ id: `call-2`, conversationId: `c2`, description: `Audit the deps` })];
    const text = (await mount({})).textContent ?? ``;
    expect(text).toContain(`Locate the handler`);
    expect(text).toContain(`Audit the deps`);
});

/* "Parent" asks for the CONVERSATION this child came out of. A plain press used to leave for /agents/:id, which
 * on a desktop is the review page, so it traded the transcript you were reading for a diff you hadn't asked
 * for. The dock is where a conversation lives there, so that is what it points, and this page stays open.
 *
 * It is still an ANCHOR carrying that address, which is the half a <button> could never offer: hover it and the
 * browser says where it goes, Ctrl/⌘-click it and the conversation opens in a tab of its own. Only the PLAIN
 * click is the app's. */
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

/* THE ROW SAYS WHICH MODEL, AND SAYS NOTHING ELSE THE CHAT RAIL WOULDN'T.
 *
 * A rail is a switcher: it is read to pick one row out of a dozen, and the model is the fact that decides it.
 * This row used to answer everything BUT that: `bg`, the parent's title clipped to three words, the agent type
 * (which is already the title of any child that has no description, and is spelled out in the pane header), and
 * a tool-call/token counter — four facts wide, none of which ever picked a row, and between them they crowded
 * out the model and pushed the live readout onto a second line of card height.
 *
 * The model is asserted on a child that reported NONE, which is the ordinary case for a running one, so what is
 * pinned here is the inheritance as much as the label. Scoped to the card, not the page: the type and the parent
 * are still answered in the pane's header, about the one child being read, which is the whole point of moving
 * them there. */
it(`names the model on the card and drops the facts that crowded it out`, async () => {
    sessions.value = [child({ background: true, toolUses: 6, tokens: 19_000 })];
    const card = (await mount({})).querySelector(`.session-card`);
    const text = card?.textContent ?? ``;
    expect(text).toContain(`Locate the handler`);
    expect(text).toContain(`x-test-model`);
    expect(text).not.toContain(`bg`);
    expect(text).not.toContain(`Explore`);
    expect(text).not.toContain(`analyse the gap`);
    expect(text).not.toContain(`19k`);
});

/* A CHILD'S TRANSCRIPT IS A TRANSCRIPT, so the one control that decides how one reads is here too: the chat's
 * own hide/show for tool calls (ChatToolCallsToggle, the very component the composer's status strip draws). It
 * reads an account preference, so a reader who folded the calls away in chat has already said what they want of
 * this pane, and it used to draw every call as a card regardless — one setting quietly meaning two things.
 *
 * In the HEADER because this pane has no composer to put a status strip under, and it has none because there is
 * nothing to send: steering a child goes through a supervision door that admits only a shell carrying a live
 * turn stamp. Hidden is the default, so the control offers to show them. */
it(`offers the chat's tool-call control, and no composer`, async () => {
    sessions.value = [child({})];
    const el = await mount({});
    expect(el.querySelector(`[aria-label="Show tool calls"]`)).not.toBeNull();
    expect(el.querySelector(`textarea`)).toBeNull();
});
