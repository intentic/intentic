// @vitest-environment jsdom
// jsdom pins what the header row is allowed to hold, per two measured failures: a longer status word squeezed the
// title (fixed by hiding words below @md), and at 390px the mode switch left no room for the title (fixed by
// moving it outside `.view-header`). Asserted structurally, not just as "present somewhere".
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

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
        useDevice: () => ({ mobile: vue.ref(true) }),
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

vi.mock("../../chat/run/useChat", async () => {
    const { ref } = await import("vue");
    return {
        useChat: () => ({
            // `peek`/`unsent` are what the phone's focus-leave sweep checks (AgentDetail.sweepPeek); this agent is one
            // the
            // reader walked into, not merely glanced at.
            conversations: ref([
                {
                    conversationId: `agent-1`,
                    title: ref(`Readable mobile title`),
                    streaming: ref(true),
                    peek: ref(false),
                    unsent: ref(false),
                },
            ]),
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
