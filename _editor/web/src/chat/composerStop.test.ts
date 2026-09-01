// @vitest-environment jsdom
//
// THE END OF THE COMPOSER ROW HOLDS ONE PRIMARY BUTTON, asserted through the real pane, because this is a rule
// about what a user's eye and finger find in one place and nothing below the DOM can express it.
//
// Mid-turn the composer has two things it could be for: stopping what is running, and writing the next message.
// The row used to show both at all times, so a live turn with an empty box put a DEAD GREY Send in the slot the
// eye goes to and demoted the live Stop to its left. The rule now: Stop takes that slot while there is nothing
// to send, the first keystroke hands it back to Send, and the two never swap order.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { providerAccounts } from "../composables/chat/providerAccounts";
import { resetChat, useChat } from "../composables/chat/useChat";
import { queryClient } from "../composables/queryPersistence";
import { useLayout } from "../composables/useLayout";
import { router } from "../router";
import ChatPanel from "./ChatPanel.vue";

// The import-time globals a mounted chat surface needs: see chatPanelPanes.test.ts, which explains each.
vi.hoisted(() => {
    globalThis.IntersectionObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof globalThis.IntersectionObserver;
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

// The fleet roster and the workflow ledger, which the pane asks about on mount and neither of which this file
// is about: an empty answer costs nothing and keeps the polling out of it.
vi.mock(`../composables/agents/useAgents`, async () => {
    const { computed } = await import(`vue`);
    return {
        useAgents: () => ({
            fleet: computed(() => []),
            agentById: () => undefined,
            archived: ref([]),
            loadArchived: () => {},
            restore: () => {},
            busyIds: ref([]),
            setResumeAfterOutage: vi.fn().mockResolvedValue(undefined),
        }),
    };
});
vi.mock(`../composables/agents/useWorkflowRuns`, async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useWorkflowRuns: () => ({ runs: ref([]), designs: ref([]), start: () => undefined, stop: () => undefined }),
}));
// The composer only exists when the sandbox does: unreachable, the whole footer yields to "Chat is available
// once your sandbox is connected" and there is no row to be about (see chatContinue.test.ts).
vi.mock(`../composables/sandbox/useSandbox`, async (importOriginal) => {
    const { computed } = await import(`vue`);
    const activeSandboxId = ref<string | undefined>(`sandbox-1`);
    const sandboxes = ref([{ id: `sandbox-1`, name: `test` }]);
    return {
        ...(await importOriginal<Record<string, unknown>>()),
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
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
};

const sendButton = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>(`button[aria-label="Send"]`);
const stopButton = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>(`button.composer-stop`);
// The round buttons at the end of the row, in DOM order: what the eye reads right-to-left and the finger lands on.
const roundButtons = (): string[] =>
    [...document.querySelectorAll<HTMLButtonElement>(`button.composer-send`)].map((element) => element.ariaLabel ?? ``);

beforeEach(async () => {
    app?.unmount();
    app = undefined;
    // BOTH stores, because a window's tabs live in sessionStorage and only seed from localStorage (windowStore).
    localStorage.clear();
    sessionStorage.clear();
    resetChat();
    // `connected` is the composer's own gate: with no account on the provider the box is inert and says so.
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

/* THE STATE THIS IS ABOUT. A live turn and an empty box: there is no message to send, so a Send button is a
 * circle that cannot be pressed sitting where the one live action should be. It goes, and Stop inherits the
 * slot: the same place, the same size, the only thing there is to do. */
it(`gives the end of the row to Stop when a turn is running and there is nothing to send`, async () => {
    const conversation = useChat().active.value;
    await mountPanel();

    conversation.streaming.value = true;
    await settle();

    expect(roundButtons()).toEqual([`Stop generating`]);
    expect(sendButton()).toBeNull();
    expect(stopButton()?.disabled).toBe(false);
});

/* AND THE FIRST KEYSTROKE HANDS IT BACK. Mid-turn text is never refused, it steers the running turn or queues
 * behind it, so the moment there are words the press has somewhere to go and the button has to be there,
 * enabled, in its usual place, with Stop stepping aside to its left rather than trading places with it. */
it(`brings Send back, last in the row, as soon as there is something to send`, async () => {
    const conversation = useChat().active.value;
    await mountPanel();

    conversation.streaming.value = true;
    conversation.draft.value = `use the other branch`;
    await settle();

    expect(roundButtons()).toEqual([`Stop generating`, `Send`]);
    expect(sendButton()?.disabled).toBe(false);
});

/* A REFUSED SEND KEEPS ITS BUTTON, which is why the rule reads the box rather than `canSend`: an edit armed
 * while a turn is running cannot go yet, and the greyed button's tooltip is the only place that says why. Take
 * the button away and the user is left holding words with nothing on screen to explain them. */
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
