// @vitest-environment jsdom
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h } from "vue";
import type { ChatMessage } from "../composables/chat/transcript";

const clock = vi.hoisted(() => ({ turnStartedAt: undefined as number | undefined }));

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

vi.mock("@intentic-app/ui", async () => {
    const { ref } = await import("vue");
    return { useDevice: () => ({ mobile: ref(false) }) };
});
vi.mock("@intentic-app/ui/markdown", () => ({ copyCodeFromEvent: vi.fn() }));
vi.mock("@intentic/sandbox-contract", () => ({ planParts: (text: string) => ({ body: text }) }));
vi.mock("../composables/chat/attachmentPreviews", () => ({ attachmentPreview: () => undefined }));
vi.mock("../composables/agents/agentStatus", () => ({ effectiveAutoLand: () => false }));
vi.mock("../composables/chat/transcript", () => ({ isAcknowledgment: () => false }));
vi.mock("../composables/useMarkdown", async () => {
    const { computed } = await import("vue");
    return { useMarkdown: () => computed(() => ({ settled: ``, tail: `` })) };
});
vi.mock("../composables/workspace/openFileRef", () => ({ openFileRefFromEvent: vi.fn() }));
vi.mock("../composables/workspace/useHistory", () => ({ restoreSnapshot: vi.fn() }));
vi.mock("./toolGrouping", () => ({ groupConsecutiveTools: () => [] }));
vi.mock("./ChatAttachmentStrip.vue", () => ({ default: { render: () => undefined } }));
vi.mock("./ChatTodoList.vue", () => ({ default: { render: () => undefined } }));
vi.mock("./ChatToolCard.vue", () => ({ default: { render: () => undefined } }));
vi.mock("./ChatToolGroup.vue", () => ({ default: { render: () => undefined } }));

vi.mock("../composables/chat/useChat", async () => {
    const { ref, shallowRef } = await import("vue");
    const active = shallowRef({
        conversationId: `agent-1`,
        providerRetry: ref(undefined),
        turnStartedAt: {
            get value(): number | undefined {
                return clock.turnStartedAt;
            },
        },
    });
    return {
        useChat: () => ({
            active,
            decidePlan: vi.fn(),
            planApprovals: ref([]),
            answerQuestion: vi.fn(),
            cancelQuestion: vi.fn(),
            decidePermission: vi.fn(),
            openPlanPreview: vi.fn(),
            editAndResend: vi.fn(),
            streaming: ref(true),
            awaitingDecision: ref(false),
        }),
    };
});

vi.mock("../composables/agents/useAgents", () => ({
    useAgents: () => ({ agentById: () => undefined, setAutoLand: vi.fn() }),
}));

vi.mock("../composables/sandbox/useSandboxSettings", async () => {
    const { ref } = await import("vue");
    return {
        useSandboxSettings: () => ({ settings: ref(undefined), save: { mutateAsync: vi.fn() } }),
    };
});

const { default: ChatMessageView } = await import("./ChatMessageView.vue");

const message: ChatMessage = { id: 1, role: `assistant`, text: `` };
let app: App | undefined;

const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatMessageView, { message, streaming: true }) });
    app.use(VueQueryPlugin, { queryClient: new QueryClient() });
    app.component(
        `Icon`,
        defineComponent({
            render: () => h(`i`),
        }),
    );
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    clock.turnStartedAt = Date.now() - 35_000;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    vi.useRealTimers();
});

describe(`ChatMessageView loader`, () => {
    it(`counts from the command start even when the view mounts later`, () => {
        const first = mount();
        expect(first.textContent).toContain(`(35s)`);

        app?.unmount();
        app = undefined;
        vi.advanceTimersByTime(12_000);

        const reopened = mount();
        expect(reopened.textContent).toContain(`(47s)`);
    });
});
