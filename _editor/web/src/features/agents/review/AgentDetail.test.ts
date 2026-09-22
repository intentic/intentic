// jsdom pins what the header row is allowed to hold, per two measured failures: a longer status word squeezed the
// title (fixed by hiding words below @md), and at 390px the mode switch left no room for the title (fixed by
// moving it outside `.view-header`). Asserted structurally, not just as "present somewhere".
import "@intentic/testing/dom";
import { it, expect, afterEach, mock, jest } from "bun:test";
import { hoisted } from "@intentic/testing/bun";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
// The threshold the header's bars wait for, read from where it's defined rather than restated as a number here.
import { REVEAL_DELAY_MS } from "@intentic/ui/loading-reveal";
import * as actualVueRouter from "vue-router";
import { RouterLinkStub } from "../../../testing/routerLinkStub";
import * as actualUi from "@intentic/ui";
import * as actualAgentActions from "../fleet/agentActions";

// What the second test turns: the form factor (a desktop page is the review, where a phone's is the chat) and whether
// either half of the fleet has answered for this id yet. Defaults are the first test's world, restored after each.
const { knobs } = hoisted(() => ({ knobs: { mobile: true, known: true } }));

// The header's back link is a real RouterLink now, which needs a router this bare mount never installs.
// Every factory below is synchronous: a mock.module factory runs in place, and awaiting inside one that replaces a
// module already in this file's graph never returns.
mock.module("vue-router", () => ({
    ...actualVueRouter,
    // `query` too: the page reads `?sandbox=`, and vue-router never produces a route object without one.
    useRoute: () => ({ params: { id: `agent-1` }, query: {} }) as never,
    useRouter: () => ({ push: mock(), replace: mock() }) as never,
    RouterLink: RouterLinkStub as never,
}));

// Snapshotted before the mocks below replace their modules: a namespace is a live binding, and the real one is
// spread so a name anything in the graph imports is never missing.
const realUi = { ...actualUi };
const realAgentActions = { ...actualAgentActions };

mock.module("@intentic/ui", () => {
    const empty = (name: string) => defineComponent({ name, render: () => null });
    return {
        ...realUi,
        ui: { iconButton: () => `` },
        // Button comes from the kit, not PrimeVue; this mount only cares where buttons are, not what they do.
        Button: empty(`Button`),
        Modal: empty(`Modal`),
        Notice: empty(`Notice`),
        ResponsiveOverlay: empty(`ResponsiveOverlay`),
        SegmentedControl: defineComponent({ name: `SegmentedControl`, render: () => h(`div`, { "data-mode-switch": `` }) }),
        useDevice: () => ({ mobile: ref(knobs.mobile) }),
    };
});

mock.module("../../chat/panel/ChatPanel.vue", () => ({ default: { render: () => null } }));
mock.module("./AgentReviewPanel.vue", () => ({ default: { render: () => null } }));
mock.module("../board/session/AgentSessionMenu.vue", () => ({ default: { render: () => null } }));
mock.module("../board/session/SessionChip.vue", () => ({ default: { render: () => null } }));
mock.module("../board/session/SessionIdentity.vue", () => ({ default: { render: () => null } }));
// The phone's chats sheet hangs off the title; a header test only cares that the title is its handle.
mock.module("../../chat/tabs/ChatSwitcherSheet.vue", () => ({ default: { render: () => null } }));

mock.module("../fleet/agentStatus", () => ({
    agentStatusMeta: () => ({ icon: `spinner`, spin: true, label: `Running`, class: `text-link` }),
    unregistered: () => false,
    writingNow: () => true,
    blocked: () => false,
    turnInFlight: () => false,
}));

mock.module("../fleet/useAgents", () => {
    const agent = { id: `agent-1`, branch: `agent/agent-1`, status: `running`, title: `Readable mobile title` };
    return {
        useAgents: () => ({
            fleet: ref(knobs.known ? [agent] : []),
            archived: ref([]),
            // An unknown id is asked about once and the page waits on the answer, so this read is the one left hanging.
            refresh: mock(() => (knobs.known ? Promise.resolve() : new Promise<void>(() => {}))),
            loadArchived: mock(async () => {}),
            open: mock(),
            agentById: () => (knobs.known ? agent : undefined),
            rename: mock(async () => {}),
        }),
    };
});

mock.module("../../chat/run/useChat", () => {
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
            setActive: mock(),
            closeTabs: mock(),
            openConversation: mock(),
            active: ref({ conversationId: `agent-1` }),
        }),
    };
});
// Stubbed strip (nothing open) so this mount skips standing up the whole tab store for a header test.
mock.module("../../chat/panel/useChat-strip", () => ({
    chatStrip: { value: { active: undefined, panes: [], tabs: [] } },
    chatPreviews: { value: {} },
    previewOf: () => undefined,
}));

mock.module("./useAgentChanges", () => {
    return {
        useAgentChanges: () => ({
            actionBusy: ref(false),
            actionError: ref(undefined),
            pending: ref([]),
            count: ref(0),
            loading: ref(false),
            land: mock(),
            discard: mock(),
            refresh: mock(),
        }),
    };
});

mock.module("../fleet/agentActions", () => ({ ...realAgentActions, requestLandAgent: mock(async () => {}), startAgent: mock() }));
mock.module("../../sandbox/secrets/useRole", () => ({ useRole: () => ({ canDrive: true, canReview: true, canShip: true }) }));

const { default: AgentDetail } = await import("./AgentDetail.vue");

let app: App | undefined;

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    knobs.mobile = true;
    knobs.known = true;
    // Only the wait test fakes them; left on, they would freeze every timer after it.
    jest.useRealTimers();
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
    // On a phone the title is the chats sheet's handle: a button taking the row's leftover width, the name truncating inside it.
    const title = header.querySelector<HTMLElement>(`button[aria-expanded]`)!;
    const name = title.querySelector<HTMLElement>(`span.truncate`)!;
    const status = header.querySelector<HTMLElement>(`[aria-label="Running"]`)!;
    const words = [...status.querySelectorAll(`span`)].find((node) => node.textContent === `Running`)!;

    // The switch renders, and outside the header: it has no width to spare for it.
    expect(el.querySelector(`[data-mode-switch]`)).not.toBeNull();
    expect(header.querySelector(`[data-mode-switch]`)).toBeNull();
    expect(name.textContent).toBe(`Readable mobile title`);
    expect(title.classList).toContain(`flex-1`);
    // Rename and the session chip left the row for the session menu; nothing but the title, its status and the menu remain.
    expect(header.querySelector(`[aria-label="Rename agent"]`)).toBeNull();
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
    jest.useFakeTimers();
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp(AgentDetail);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    await nextTick();

    // Under the reveal delay the answer still reads as immediate, so nothing is drawn.
    expect(el.querySelector(`.skeleton`)).toBeNull();

    jest.advanceTimersByTime(REVEAL_DELAY_MS);
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
