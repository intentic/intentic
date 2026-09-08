// @vitest-environment jsdom
// Pins what the panel draws against the real DOM, not the store: a correctly picked chat, a run that releases cleanly,
// and no column drawn for a chat that never arrived.
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { chatRun, showRun } from "../run/chatRun";
import { resetChat, useChat } from "../run/useChat";
import { draftConversation, reveal } from "./useChat-reveal";
// The store half of "New agent", as summons applies it (agentActions.startAgent); the fixture these suites use to open
// extra tabs.
const newChat = () => {
    const conversation = draftConversation();
    reveal({ verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: false });
    return conversation;
};

import { queryClient } from "../../../lib/queryPersistence";
import { MIN_PANE_PX, useLayout } from "../../../shell/window/useLayout";
import { router } from "../../../router";
import ChatPanel from "./ChatPanel.vue";
import { IconStub } from "@intentic/ui/testing";

// useDevice reads matchMedia at module load (matches:false keeps it desktop, the only form factor with panes); jsdom
// implements neither IntersectionObserver nor scrollIntoView.
vi.hoisted(() => {
    globalThis.IntersectionObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof globalThis.IntersectionObserver;
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

// The workflow ledger as the panel sees it, driven directly by these tests.
const runs = ref<WorkflowRun[]>([]);
// An empty roster avoids driving the real fleet queries in a test about which chat the panel shows; none of these
// fixtures fork.
vi.mock(`../../agents/fleet/useAgents`, async () => {
    const { computed } = await import(`vue`);
    return { useAgents: () => ({ fleet: computed(() => []), agentById: () => undefined }) };
});
vi.mock(`../../agents/fleet/useWorkflowRuns`, async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useWorkflowRuns: () => ({ runs, designs: ref([]), start: () => undefined, stop: () => undefined }),
}));

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

// Chats the panel drew, in column order, read from each conversation's self-naming message.
const onScreen = (): string[] =>
    [...document.querySelectorAll(`.chat-pane`)].map((pane) => /shows-[a-z]+/.exec(pane.textContent ?? ``)?.[0] ?? `<empty>`);

// A conversation the panel can show, named so the DOM says which one is on screen.
const namedChat = (name: string, id?: string) => {
    const chat = useChat();
    const conversation = id === undefined ? newChat() : chat.active.value;
    conversation.restoreMessages([{ role: `user`, text: `shows-${name}` }]);
    return conversation;
};

// A one-step run on one conversation; `running` is what makes the panel follow it.
const runWithStep = (state: "running" | "done", conversationId: string): WorkflowRun =>
    ({
        runId: `run-1`,
        state,
        workflow: { name: `Six phases`, steps: [{ id: `s1`, needs: [] }] },
        steps: [{ stepId: `s1`, conversationId, state }],
    }) as unknown as WorkflowRun;

beforeEach(async () => {
    app?.unmount();
    app = undefined;
    localStorage.clear();
    resetChat();
    chatRun.value = undefined;
    runs.value = [];
    // Wide enough for the docked panel to draw its whole pane set.
    useLayout().setChatWidth(2000);
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
});

// jsdom does not lay anything out; this pins the floor arithmetic (MIN_PANE_PX), not an actual measured collision.
it(`never lets the column stop narrower than one pane`, () => {
    const layout = useLayout();
    layout.setChatWidth(0);
    expect(layout.chatWidth.value).toBe(MIN_PANE_PX);
});

it(`draws the chat that was picked`, async () => {
    const chat = useChat();
    const mine = namedChat(`mine`, chat.activeId.value);
    const other = namedChat(`other`);
    chat.setActive(mine.conversationId);
    await mountPanel();
    expect(onScreen()).toEqual([`shows-mine`]);

    chat.setActive(other.conversationId);
    await settle();

    expect(onScreen()).toEqual([`shows-other`]);
});

// The pick must end the follow even though nothing can be looked up about the run yet, since the ledger just went empty
// mid-push.
it(`lets go of a run picked away from while the ledger has no reading for it`, async () => {
    const chat = useChat();
    const mine = namedChat(`mine`, chat.activeId.value);

    await mountPanel();
    runs.value = [runWithStep(`running`, `step-1`)];
    showRun(`run-1`, `live`);
    await settle();
    expect(chat.panes.value).toEqual([`step-1`]);

    runs.value = []; // the ledger blinks (goes empty)
    await settle();
    chat.setActive(mine.conversationId); // the reader picks their own chat during the blink
    await settle();
    expect(onScreen()).toEqual([`shows-mine`]);

    runs.value = [runWithStep(`running`, `step-1`)]; // the ledger returns, run still going

    await settle();

    expect(chatRun.value).toBeUndefined();
    expect(onScreen()).toEqual([`shows-mine`]);
});

it(`lets go of a run picked away from while the ledger holds it`, async () => {
    const chat = useChat();
    const mine = namedChat(`mine`, chat.activeId.value);

    await mountPanel();
    runs.value = [runWithStep(`running`, `step-1`)];
    showRun(`run-1`, `live`);
    await settle();

    chat.setActive(mine.conversationId);
    await settle();
    runs.value = [runWithStep(`running`, `step-1`)];
    await settle();

    expect(chatRun.value).toBeUndefined();
    expect(onScreen()).toEqual([`shows-mine`]);
});

it(`names the run that is driving it, docked, with the way out`, async () => {
    namedChat(`mine`, useChat().activeId.value);
    await mountPanel();

    runs.value = [runWithStep(`running`, `step-1`)];
    showRun(`run-1`, `live`);
    await settle();

    expect(document.querySelectorAll(`[aria-label="Leave the run"]`).length).toBe(1);
    expect(document.body.textContent).toContain(`Six phases`);
});

// openBeside reserves the column before the chat exists; between the claim and the open, the id names nothing yet.
it(`draws no column for a chat that never arrived`, async () => {
    const chat = useChat();
    namedChat(`mine`, chat.activeId.value);
    const other = namedChat(`other`);
    chat.setActive(chat.conversations.value[0]!.conversationId);
    await mountPanel();

    chat.openBeside(`claimed-by-nobody`);
    await settle();
    expect(onScreen()).toEqual([`shows-mine`]);

    chat.setActive(other.conversationId);
    await settle();

    expect(onScreen()).toEqual([`shows-other`]);
});
