// @vitest-environment jsdom
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";
import { ERRANDS, errandPrompt } from "../composables/chat/errands";
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
// withoutResumeNote is the real behaviour, not a stub: the errand row depends on it to recognise an errand a
// resumed turn re-sent (errands.ts), and a mock that returned the text unchanged would hide that.
vi.mock("@intentic/sandbox-contract", async () => {
    const { withoutResumeNote } = await vi.importActual<typeof import("@intentic/sandbox-contract")>("@intentic/sandbox-contract");
    return { planParts: (text: string) => ({ body: text }), withoutResumeNote };
});
vi.mock("../composables/chat/attachmentPreviews", () => ({ attachmentPreview: () => undefined }));
// formatElapsed is the real one — the loader's readout IS that format, so mocking it would test nothing.
vi.mock("../composables/agents/agentStatus", async () => {
    const { formatElapsed } = await vi.importActual<typeof import("../composables/agents/agentStatus")>("../composables/agents/agentStatus");
    return { effectiveAutoLand: () => false, formatElapsed };
});
vi.mock("../composables/chat/transcript", async () => {
    const { errandOf } = await vi.importActual<typeof import("../composables/chat/errands")>("../composables/chat/errands");
    return { foldsIntoTurn: (message: ChatMessage) => errandOf(message) !== undefined };
});
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

const mount = (subject: ChatMessage = message): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatMessageView, { message: subject, streaming: true }) });
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

    // A long turn is the case the readout exists for, and "(525s)" is arithmetic the reader has to do.
    it(`reads long turns in minutes and hours rather than a growing second count`, () => {
        clock.turnStartedAt = Date.now() - 525_000;
        expect(mount().textContent).toContain(`(8m 45s)`);

        app?.unmount();
        app = undefined;
        clock.turnStartedAt = Date.now() - 3_960_000;
        expect(mount().textContent).toContain(`(1h 6m)`);
    });

    // The counter ticks off a `now` the interval refreshes — a turn whose start is unknown gets no parenthetical
    // at all rather than a stuck "(0s)".
    it(`ticks while the turn runs and drops the readout when the start is unknown`, async () => {
        const element = mount();
        vi.advanceTimersByTime(30_000);
        await nextTick();
        expect(element.textContent).toContain(`(1m 5s)`);

        app?.unmount();
        app = undefined;
        clock.turnStartedAt = undefined;
        expect(mount().textContent).not.toContain(`(`);
    });
});

/* An errand is the app's prompt, not the user's (errands.ts): the row says what was asked for, and the words
 * the agent actually got are behind one press rather than gone — the audit trail is the whole reason this is a
 * fold rather than a suppression. */
describe(`ChatMessageView errand row`, () => {
    const errand = ERRANDS.landConflict;
    const prompt = errandPrompt(errand, [`What blocked the land:\nroot\n  - src/auth/session.ts`]);

    it(`names the errand and keeps its prompt one press away rather than on screen`, async () => {
        const element = mount({ id: 2, role: `user`, text: prompt });
        expect(element.textContent).toContain(errand.label);
        expect(element.textContent).toContain(errand.detail);
        expect(element.textContent).not.toContain(`src/auth/session.ts`);
        // Never sticky: the pin belongs to the question this errand serves, one turn up.
        expect(element.querySelector(`.chat-prompt`)).toBeNull();

        element.querySelector(`button`)?.click();
        await nextTick();
        expect(element.textContent).toContain(`src/auth/session.ts`);
    });
});
