// @vitest-environment jsdom
//
// jsdom because the contract here is the header AgentDetail actually renders. It cannot calculate flexbox, but
// it can pin WHAT IS ALLOWED IN THE HEADER ROW, which is what two measured production failures came down to.
//
// The first: the status words and Chat | Changes both sat in that row, so a longer status ("Idle" → "Running")
// left the title a four-pixel box. The words were made to stand down below the header's @md width, keeping
// their accessible name: that is the `hidden @md:inline` pair below.
//
// The second, measured at 390px: even with the words gone the row held a back arrow, the title, a rename
// pencil, the session chip, the status glyph, the ~120px switch and the actions menu, and the title got 55px
// for a string needing 250: "Add Stripe checkout to the pricing page" rendered "Add St…". The switch moved to
// a full-width row of its own beneath the header, so THE SWITCH BEING OUTSIDE `.view-header` is now the
// contract, and it is asserted as such rather than merely "present somewhere in the component", which is
// what the old assertion said, and which stayed true throughout the failure it was meant to prevent.
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";

// The header's way back to the board is a link now, so this mock has to carry a <RouterLink>: the real one
// resolves its href out of a router this bare mount never installs.
vi.mock(import("vue-router"), async (importOriginal) => ({
    ...(await importOriginal()),
    // `query` as well as `params`: the page reads `?sandbox=` to decide whether this review is of an agent in
    // another box, and a route object without one is a shape vue-router never produces.
    useRoute: () => ({ params: { id: `agent-1` }, query: {} }) as never,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) as never,
    RouterLink: (await import("../testing/routerLinkStub")).RouterLinkStub as never,
}));

vi.mock("@intentic/ui", async () => {
    const vue = await import("vue");
    const empty = (name: string) => vue.defineComponent({ name, render: () => null });
    return {
        ui: { iconButton: () => `` },
        // The app's action button comes from the kit now rather than straight from PrimeVue, so the stub does
        // too: this mount only cares where the buttons ARE, not what they do when pressed.
        Button: empty(`Button`),
        Modal: empty(`Modal`),
        ResponsiveOverlay: empty(`ResponsiveOverlay`),
        SegmentedControl: vue.defineComponent({ name: `SegmentedControl`, render: () => vue.h(`div`, { "data-mode-switch": `` }) }),
        useDevice: () => ({ mobile: vue.ref(true) }),
    };
});

vi.mock("../chat/ChatPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("./AgentReviewPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("./AgentSessionMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("./SessionChip.vue", () => ({ default: { render: () => null } }));
vi.mock("./SessionIdentity.vue", () => ({ default: { render: () => null } }));

vi.mock("../composables/agents/agentStatus", () => ({
    agentStatusMeta: () => ({ icon: `spinner`, spin: true, label: `Running`, class: `text-link` }),
    unregistered: () => false,
    writingNow: () => true,
}));

vi.mock("../composables/agents/useAgents", async () => {
    const { ref } = await import("vue");
    const agent = { id: `agent-1`, branch: `agent/agent-1`, status: `running`, title: `Readable mobile title` };
    return {
        useAgents: () => ({
            fleet: ref([agent]),
            archived: ref([]),
            refresh: vi.fn(async () => {}),
            loadArchived: vi.fn(async () => {}),
            open: vi.fn(),
            agentById: () => agent,
            rename: vi.fn(async () => {}),
        }),
    };
});

vi.mock("../composables/chat/useChat", async () => {
    const { ref } = await import("vue");
    return {
        useChat: () => ({
            conversations: ref([{ conversationId: `agent-1`, title: ref(`Readable mobile title`), streaming: ref(true) }]),
            setActive: vi.fn(),
        }),
    };
});

vi.mock("../composables/inlineRename", async () => {
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

vi.mock("../composables/agents/useAgentChanges", async () => {
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

vi.mock("../composables/agents/agentActions", () => ({ requestLandAgent: vi.fn(async () => {}) }));
vi.mock("../composables/sandbox/useRole", () => ({ useRole: () => ({ canDrive: true, canShip: true }) }));

const { default: AgentDetail } = await import("./AgentDetail.vue");

let app: App | undefined;

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`keeps a mobile running agent's title slot: the view switch is not in the header, and only the status words compact`, async () => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp(AgentDetail);
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
    app.mount(el);
    await nextTick();

    const header = el.querySelector<HTMLElement>(`.view-header`)!;
    const title = header.querySelector<HTMLElement>(`span.flex-1.truncate`)!;
    const status = header.querySelector<HTMLElement>(`[aria-label="Running"]`)!;
    const words = [...status.querySelectorAll(`span`)].find((node) => node.textContent === `Running`)!;

    // The switch is rendered, and it is rendered OUTSIDE the header: the header has no width to spare for it.
    expect(el.querySelector(`[data-mode-switch]`)).not.toBeNull();
    expect(header.querySelector(`[data-mode-switch]`)).toBeNull();
    expect(title.textContent).toBe(`Readable mobile title`);
    expect(title.classList).toContain(`flex-1`);
    expect(words.classList).toContain(`hidden`);
    expect(words.classList).toContain(`@md:inline`);
    expect(status.getAttribute(`aria-label`)).toBe(`Running`);
});
