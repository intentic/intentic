// @vitest-environment jsdom
// jsdom pins what the header row is allowed to hold, per two measured failures: a longer status word squeezed the
// title (fixed by hiding words below @md), and at 390px the mode switch left no room for the title (fixed by
// moving it outside `.view-header`). Asserted structurally, not just as "present somewhere".
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";
// The threshold the header's bars wait for, read from where it's defined rather than restated as a number here.
import { REVEAL_DELAY_MS } from "@intentic/ui/loading-reveal";

// What the second test turns: the form factor (a desktop page is the review, where a phone's is the chat) and whether
// either half of the fleet has answered for this id yet. Defaults are the first test's world, restored after each.
const { knobs } = vi.hoisted(() => ({ knobs: { mobile: true, known: true } }));

// The header's back link is a real RouterLink now, which needs a router this bare mount never installs.
vi.mock(import("vue-router"), async (importOriginal) => ({
    ...(await importOriginal()),
    // `query` too: the page reads `?sandbox=`, and vue-router never produces a route object without one.
    useRoute: () => ({ params: { id: `agent-1` }, query: {} }) as never,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) as never,
    RouterLink: (await import("../../../testing/routerLinkStub")).RouterLinkStub as never,
}));

vi.mock("@intentic/ui", async () => {
    const vue = await import("vue");
    const empty = (name: string) => vue.defineComponent({ name, render: () => null });
    return {
        ui: { iconButton: () => `` },
        // Button comes from the kit, not PrimeVue; this mount only cares where buttons are, not what they do.
        Button: empty(`Button`),
        Modal: empty(`Modal`),
        ResponsiveOverlay: empty(`ResponsiveOverlay`),
        SegmentedControl: vue.defineComponent({ name: `SegmentedControl`, render: () => vue.h(`div`, { "data-mode-switch": `` }) }),
        useDevice: () => ({ mobile: vue.ref(knobs.mobile) }),
        // The real one: the header's bars and the review's outline are exactly its two thresholds.
        useLoadingReveal: (await import("@intentic/ui/loading-reveal")).useLoadingReveal,
    };
});

vi.mock("../../chat/panel/ChatPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("./AgentReviewPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("../board/AgentSessionMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("../board/SessionChip.vue", () => ({ default: { render: () => null } }));
vi.mock("../board/SessionIdentity.vue", () => ({ default: { render: () => null } }));

vi.mock("../fleet/agentStatus", () => ({
    agentStatusMeta: () => ({ icon: `spinner`, spin: true, label: `Running`, class: `text-link` }),
    unregistered: () => false,
    writingNow: () => true,
}));

vi.mock("../fleet/useAgents", async () => {
    const { ref } = await import("vue");
    const agent = { id: `agent-1`, branch: `agent/agent-1`, status: `running`, title: `Readable mobile title` };
    return {
        useAgents: () => ({
            fleet: ref(knobs.known ? [agent] : []),
            archived: ref([]),
            // An unknown id is asked about once and the page waits on the answer, so this read is the one left hanging.
            refresh: vi.fn(() => (knobs.known ? Promise.resolve() : new Promise<void>(() => {}))),
            loadArchived: vi.fn(async () => {}),
            open: vi.fn(),
            agentById: () => (knobs.known ? agent : undefined),
            rename: vi.fn(async () => {}),
        }),
    };
});

vi.mock("../../chat/run/useChat", async () => {
    const { ref } = await import("vue");
    return {
        useChat: () => ({
            // `peek`/`unsent` are what the phone's focus-leave sweep checks (AgentDetail.sweepPeek); this agent is one
            // the
            // reader walked into, not merely glanced at.
            // Empty for an id nothing has answered for: a tab would name the agent the header is still waiting on.
            conversations: ref(
                knobs.known
                    ? [
                          {
                              conversationId: `agent-1`,
                              title: ref(`Readable mobile title`),
                              streaming: ref(true),
                              peek: ref(false),
                              unsent: ref(false),
                          },
                      ]
                    : [],
            ),
            setActive: vi.fn(),
            closeTabs: vi.fn(),
        }),
    };
});
// Stubbed strip (nothing open) so this mount skips standing up the whole tab store for a header test.
vi.mock("../../chat/panel/useChat-strip", () => ({ chatStrip: { value: { active: undefined, panes: [], tabs: [] } } }));

vi.mock("../../../lib/inlineRename", async () => {
    const { reactive } = await import("vue");
    return {
        createInlineRename: () =>
            reactive({
                editing: false,
                draft: ``,
                error: undefined as string | undefined,
                begin: vi.fn(),
                commit: vi.fn(),
                cancel: vi.fn(),
                blurCommit: vi.fn(),
                focusInput: vi.fn(),
            }),
    };
});

vi.mock("./useAgentChanges", async () => {
    const { ref } = await import("vue");
    return {
        useAgentChanges: () => ({
            actionBusy: ref(false),
            pending: ref([]),
            count: ref(0),
            loading: ref(false),
            land: vi.fn(),
            discard: vi.fn(),
            refresh: vi.fn(),
        }),
    };
});

vi.mock("../fleet/agentActions", () => ({ requestLandAgent: vi.fn(async () => {}) }));
vi.mock("../../sandbox/secrets/useRole", () => ({ useRole: () => ({ canDrive: true, canShip: true }) }));

const { default: AgentDetail } = await import("./AgentDetail.vue");

let app: App | undefined;

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    knobs.mobile = true;
    knobs.known = true;
    // Only the wait test fakes them; left on, they would freeze every timer after it.
    vi.useRealTimers();
});

it(`keeps a mobile running agent's title slot: the view switch is not in the header, and only the status words compact`, async () => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp(AgentDetail);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    await nextTick();

    const header = el.querySelector<HTMLElement>(`.view-header`)!;
    const title = header.querySelector<HTMLElement>(`span.flex-1.truncate`)!;
    const status = header.querySelector<HTMLElement>(`[aria-label="Running"]`)!;
    const words = [...status.querySelectorAll(`span`)].find((node) => node.textContent === `Running`)!;

    // The switch renders, and outside the header: it has no width to spare for it.
    expect(el.querySelector(`[data-mode-switch]`)).not.toBeNull();
    expect(header.querySelector(`[data-mode-switch]`)).toBeNull();
    expect(title.textContent).toBe(`Readable mobile title`);
    expect(title.classList).toContain(`flex-1`);
    expect(words.classList).toContain(`hidden`);
    expect(words.classList).toContain(`@md:inline`);
    expect(status.getAttribute(`aria-label`)).toBe(`Running`);
});

// Opening a review by URL (a bookmark, a reload, a link from another sandbox) reaches this page before the roster has
// answered for the id. That used to be a header reading "Agent" over an empty pane, which is what a real agent that
// changed nothing looks like; now the page holds the shape of what it is about to show.
it(`holds the header's places and the review's shape while the fleet is still being asked about the id`, async () => {
    knobs.mobile = false;
    knobs.known = false;
    vi.useFakeTimers();
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp(AgentDetail);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    await nextTick();

    // Under the reveal delay the answer still reads as immediate, so nothing is drawn.
    expect(el.querySelector(`.skeleton`)).toBeNull();

    vi.advanceTimersByTime(REVEAL_DELAY_MS);
    await nextTick();

    // The header keeps a bar where the name and the status will be, and never prints the word "Agent" as a stand-in.
    const header = el.querySelector<HTMLElement>(`.view-header`)!;
    expect(header.querySelectorAll(`.skeleton`).length).toBe(2);
    expect(header.textContent).not.toContain(`Agent`);
    // And the pane below is the review's own shape, announced once, instead of the empty screen it used to be.
    const status = el.querySelector(`[role="status"]`)!;
    expect(status.textContent).toContain(`Opening this agent's review…`);
    expect(status.querySelector(`aside`)).not.toBeNull();
});
