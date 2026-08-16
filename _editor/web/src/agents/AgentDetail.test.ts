// @vitest-environment jsdom
//
// jsdom because the contract here is the header AgentDetail actually renders. It cannot calculate flexbox,
// but it can pin the allocation rule that fixes the measured production failure: a registered mobile agent
// carries both the status and Chat | Changes, so the status words stand down below the header's @md width while
// their accessible name remains. Without that one class the fixed controls consumed the row and left the title
// a four-pixel box whenever "Idle" became "Running".
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";

vi.mock("vue-router", () => ({
    useRoute: () => ({ params: { id: `agent-1` } }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@intentic/ui", async () => {
    const vue = await import("vue");
    const empty = (name: string) => vue.defineComponent({ name, render: () => null });
    return {
        ui: { iconButton: () => `` },
        Modal: empty(`Modal`),
        ResponsiveOverlay: empty(`ResponsiveOverlay`),
        SegmentedControl: vue.defineComponent({ name: `SegmentedControl`, render: () => vue.h(`div`, { "data-mode-switch": `` }) }),
        useDevice: () => ({ mobile: vue.ref(true) }),
    };
});

vi.mock("primevue/button", async () => {
    const vue = await import("vue");
    return { default: vue.defineComponent({ name: `Button`, render: () => null }) };
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

it(`keeps a mobile running agent's title slot by compacting only the status words`, async () => {
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

    expect(el.querySelector(`[data-mode-switch]`)).not.toBeNull();
    expect(title.textContent).toBe(`Readable mobile title`);
    expect(title.classList).toContain(`flex-1`);
    expect(words.classList).toContain(`hidden`);
    expect(words.classList).toContain(`@md:inline`);
    expect(status.getAttribute(`aria-label`)).toBe(`Running`);
});
