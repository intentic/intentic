// Stop in the mounted pane for a turn only the board's card says runs: one another window, a wake or the resume pass
// started, which this window follows no stream of yet. The composer used to read idle over it (2026-10-28,
// snug-condor-4nbi), offering Send where Stop belonged; its Stop now goes the board's way (agentActions.stopAgent).
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { stubGlobal } from "@intentic/testing/bun";
import * as useSandboxOriginal from "../../../client/sandbox/useSandbox";
import * as useWorkflowRunsOriginal from "../../../models/fleet/useWorkflowRuns";
import { runningTurn } from "../../../testing/runningTurn";
import * as agentActionsOriginal from "../../../models/fleet/agentActions";
import { NO_ATTENTION } from "../../../models/agent-status/agentStatus-lanes";
import type { FleetAgent } from "../../../models/fleet/useAgents-fleet";

// The import-time globals a mounted chat surface needs, which jsdom lacks.
stubGlobal(
    `IntersectionObserver`,
    class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    },
);
globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};

// The board's card for the chat, whatever a case sets; the workflow ledger is irrelevant, and kept out of polling.
const card = ref<FleetAgent | undefined>();
jest.mock(`../../../models/fleet/useAgents`, () => {
    return {
        useAgents: () => ({
            fleet: computed(() => (card.value === undefined ? [] : [card.value])),
            agentById: (id: string) => (card.value?.id === id ? card.value : undefined),
            archived: ref([]),
            loadArchived: () => {},
            restore: () => {},
            busyIds: ref([]),
            setResumeAfterOutage: jest.fn().mockResolvedValue(undefined),
        }),
    };
});
// The board's Stop, caught: what it sends is pinned in useChat-view.test.ts.
const stopAgent = jest.fn((_id: string, _at?: string) => Promise.resolve());
jest.mock(`../../../models/fleet/agentActions`, () => ({ ...agentActionsOriginal, stopAgent }));
jest.mock(`../../../models/fleet/useWorkflowRuns`, () => ({
    ...useWorkflowRunsOriginal,
    useWorkflowRuns: () => ({ runs: ref([]), designs: ref([]), start: () => undefined, stop: () => undefined }),
}));
// The composer only renders once the sandbox is reachable; mocked online here.
jest.mock(`../../../client/sandbox/useSandbox`, () => {
    const activeSandboxId = ref<string | undefined>(`sandbox-1`);
    const sandboxes = ref([{ id: `sandbox-1`, name: `test` }]);
    return {
        ...useSandboxOriginal,
        useSandbox: () => ({
            sandboxes,
            activeSandboxId,
            active: computed(() => sandboxes.value[0]),
            daemonUrl: computed(() => `http://localhost`),
            connection: ref({
                phase: `online`,
                failure: undefined,
                attempt: 0,
                retryDelayMs: 0,
                everOnline: true,
                unavailableSince: undefined,
                generation: 0,
            }),
            reachable: ref(true),
            list: { isPending: ref(false) },
            refresh: () => {},
            select: () => {},
            create: () => {},
            update: () => {},
            attach: () => {},
            remove: () => {},
        }),
    };
});

// Imported after the mocks, not above them: a static import links the panel's whole graph to the real modules
// before a single jest.mock has run.
const { providerAccounts } = await import("../../../models/providers/providerAccounts");
const { useChat } = await import("../../../models/conversations/run/useChat");
const { queryClient } = await import("../../../lib/queryPersistence");
const { useLayout } = await import("../../../workbench/window/useLayout");
const { router } = await import("../../../router");
const { default: ChatPanel } = await import("./ChatPanel.vue");

let app: App | undefined;

const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
    await nextTick();
};

const mountPanel = async (): Promise<void> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    app = createApp({ render: () => h(ChatPanel) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
};

const sendButton = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>(`button[aria-label="Send"]`);
const stopButton = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>(`button.composer-stop`);
// The round buttons at the end of the row, in DOM order. The send's caret is half of the send (its split), not a button
// of its own in the row's order, so it is read with the send it hangs on.
const roundButtons = (): string[] =>
    [...document.querySelectorAll<HTMLButtonElement>(`button.composer-send:not(.composer-split-caret)`)].map((element) => element.ariaLabel ?? ``);

beforeEach(async () => {
    app?.unmount();
    app = undefined;
    // Clears both stores: a window's tabs live in sessionStorage, seeded from localStorage.
    localStorage.clear();
    sessionStorage.clear();
    resetSandboxScope();
    // `connected` gates the composer: with no provider account the box is inert.
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acc-1`, label: `a@b.c`, connectedAt: 1 }] };
    useLayout().setChatWidth(2000);
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    card.value = undefined;
    stopAgent.mockClear();
    providerAccounts.value = { ...providerAccounts.value, claude: [] };
});

const running = (id: string, status: FleetAgent[`status`] = `running`): FleetAgent => ({
    id,
    title: `Fix the parser`,
    provider: `claude`,
    harness: `native`,
    status,
    run: `r-elsewhere`,
    updatedAt: 2_000,
    attention: NO_ATTENTION,
    open: true,
    unread: false,
    unsent: false,
});

it(`gives the end of the row to Stop for a turn only the card says runs, and stops it the board's way`, async () => {
    const conversation = useChat().active.value;
    card.value = running(conversation.conversationId);
    await mountPanel();

    expect(conversation.turn.streaming.value).toBe(false);
    expect(roundButtons()).toEqual([`Stop generating`]);
    expect(sendButton()).toBeNull();

    stopButton()?.click();
    expect(stopAgent.mock.calls).toEqual([[conversation.conversationId, undefined]]);
});

it(`hands the slot back to Send once a Stop made anywhere is unwinding the turn`, async () => {
    const conversation = useChat().active.value;
    card.value = running(conversation.conversationId);
    await mountPanel();

    card.value = running(conversation.conversationId, `stopping`);
    await settle();

    expect(roundButtons()).toEqual([`Send`]);
    expect(stopButton()).toBeNull();
});

it(`stops a turn this window follows by its own path, as it always did`, async () => {
    const conversation = useChat().active.value;
    card.value = running(conversation.conversationId, `idle`);
    await mountPanel();
    const own = jest.spyOn(conversation.turn, `stop`).mockReturnValue(undefined);

    runningTurn(conversation.turn);
    await settle();
    stopButton()?.click();

    expect(own).toHaveBeenCalledTimes(1);
    expect(stopAgent).not.toHaveBeenCalled();
});

it(`keeps Send alone in the row over an idle card`, async () => {
    const conversation = useChat().active.value;
    card.value = running(conversation.conversationId, `idle`);
    await mountPanel();

    expect(roundButtons()).toEqual([`Send`]);
});

// A resume runs nothing until its re-run starts (conversation-status.ts): a Stop there found no run to end (turn-doors.ts
// stopTurn answers `stopped: false`), the card flashed "stopping" and went back to resuming, and the board refuses it.
it(`keeps Send in the row over a resume, with no Stop that would find nothing to end`, async () => {
    const conversation = useChat().active.value;
    card.value = running(conversation.conversationId, `resuming`);
    await mountPanel();

    expect(roundButtons()).toEqual([`Send`]);
    expect(stopButton()).toBeNull();
});
