// The composer row ends in one primary button, asserted through the mounted pane. Stop takes that slot while
// there is nothing to send; the first keystroke hands it back to Send, and the two never swap order.
import "@intentic/testing/dom";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { it, expect, beforeEach, afterEach, mock } from "bun:test";
import { hoisted } from "@intentic/testing/bun";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as useSandboxOriginal from "../../sandbox/client/useSandbox";
import * as useWorkflowRunsOriginal from "../../agents/fleet/useWorkflowRuns";

// The import-time globals a mounted chat surface needs.
hoisted(() => {
    globalThis.IntersectionObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof globalThis.IntersectionObserver;
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

// Fleet roster and workflow ledger are irrelevant here; empty mocks keep polling out of it.
mock.module(`../../agents/fleet/useAgents`, () => {
    return {
        useAgents: () => ({
            fleet: computed(() => []),
            agentById: () => undefined,
            archived: ref([]),
            loadArchived: () => {},
            restore: () => {},
            busyIds: ref([]),
            setResumeAfterOutage: mock().mockResolvedValue(undefined),
        }),
    };
});
mock.module(`../../agents/fleet/useWorkflowRuns`, () => ({
    ...useWorkflowRunsOriginal,
    useWorkflowRuns: () => ({ runs: ref([]), designs: ref([]), start: () => undefined, stop: () => undefined }),
}));
// The composer only renders once the sandbox is reachable; mocked online here.
mock.module(`../../sandbox/client/useSandbox`, () => {
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
// before a single mock.module has run.
const { providerAccounts } = await import("../accounts/providerAccounts");
const { resetChat, useChat } = await import("../run/useChat");
const { queryClient } = await import("../../../lib/queryPersistence");
const { useLayout } = await import("../../../shell/window/useLayout");
const { router } = await import("../../../router");
const { default: ChatPanel } = await import("../panel/ChatPanel.vue");

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
// The round buttons at the end of the row, in DOM order.
const roundButtons = (): string[] =>
    [...document.querySelectorAll<HTMLButtonElement>(`button.composer-send`)].map((element) => element.ariaLabel ?? ``);

beforeEach(async () => {
    app?.unmount();
    app = undefined;
    // Clears both stores: a window's tabs live in sessionStorage, seeded from localStorage.
    localStorage.clear();
    sessionStorage.clear();
    resetChat();
    // `connected` gates the composer: with no provider account the box is inert.
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acc-1`, email: `a@b.c` }] as never };
    useLayout().setChatWidth(2000);
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    providerAccounts.value = { ...providerAccounts.value, claude: [] };
});

// The settled chat, for contrast: one button, and it is Send.
it(`ends the row with Send while nothing is running`, async () => {
    await mountPanel();

    expect(roundButtons()).toEqual([`Send`]);
    expect(stopButton()).toBeNull();
});

// A live turn with an empty box: Send would be unpressable, so it disappears and Stop inherits its slot.
it(`gives the end of the row to Stop when a turn is running and there is nothing to send`, async () => {
    const conversation = useChat().active.value;
    await mountPanel();

    conversation.streaming.value = true;
    await settle();

    expect(roundButtons()).toEqual([`Stop generating`]);
    expect(sendButton()).toBeNull();
    expect(stopButton()?.disabled).toBe(false);
});

// Mid-turn text is never refused, only steered or queued; the first keystroke restores Send, with Stop
// stepping aside rather than trading places.
it(`brings Send back, last in the row, as soon as there is something to send`, async () => {
    const conversation = useChat().active.value;
    await mountPanel();

    conversation.streaming.value = true;
    conversation.draft.value = `use the other branch`;
    await settle();

    expect(roundButtons()).toEqual([`Stop generating`, `Send`]);
    expect(sendButton()?.disabled).toBe(false);
});

// A refused Send keeps its button rather than vanishing: the rule reads the box, not `canSend`, so the
// greyed button's tooltip can say why it can't go yet.
it(`keeps a greyed Send on screen when it is refusing words the user has already typed`, async () => {
    const conversation = useChat().active.value;
    conversation.restoreMessages([
        { role: `user`, text: `clean the sandbox` },
        { role: `assistant`, text: `done` },
    ]);
    await mountPanel();

    conversation.streaming.value = true;
    conversation.draft.value = `hold on`;
    conversation.attachments.value = [{ id: `a-1`, name: `shot.png`, path: `shot.png`, status: `uploading`, progress: 0.4 }];
    await settle();

    expect(roundButtons()).toEqual([`Stop generating`, `Send`]);
    expect(sendButton()?.disabled).toBe(true);
});
