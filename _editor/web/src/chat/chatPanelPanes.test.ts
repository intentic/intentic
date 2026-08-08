// @vitest-environment jsdom
//
// WHAT THE PANEL PUTS ON SCREEN IS THE CHAT THAT WAS PICKED — asserted through the real panel and read back
// off the DOM, because the store has never been the half that was wrong. `chat panes` in useChat.test.ts
// already pins the pane set; every failure this file is about had a correct pane set behind it and the wrong
// columns in front of it.
//
// The report it comes from is "the chat window is stuck on one session": clicking down the rail or the board
// moves the highlight and leaves the transcript where it was, for the rest of the session, until the window is
// reloaded. Two independent ways to get there, both here:
//   · A RUN THAT WAS NEVER LET GO OF. Following a workflow moves the panes by itself on every ledger push, and
//     the rule that ends it — the reader picking a chat outside the run — used to be skipped whenever the
//     ledger had no reading for the run. The ledger is emptied and refetched on a daemon rebuild, so the
//     release was dropped on exactly the beat it mattered and the run went on reseating the panel forever.
//   · A COLUMN CLAIMED FOR A CHAT THAT NEVER ARRIVED, which used to be drawn as a second copy of the focused
//     chat — two columns under one key, which is a duplicate key in a keyed list.
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { chatRun, showRun } from "../composables/chat/chatRun";
import { resetChat, useChat } from "../composables/chat/useChat";
import { queryClient } from "../composables/queryPersistence";
import { useLayout } from "../composables/useLayout";
import { router } from "../router";
import ChatPanel from "./ChatPanel.vue";

// The import-time globals a mounted chat surface needs (see startAgent.test.ts): useDevice reads matchMedia at
// module scope (matches:false keeps the device DESKTOP, the only form factor with panes), environment.ts reads
// window.env, and jsdom implements neither observer nor scrollIntoView.
vi.hoisted(() => {
    globalThis.ResizeObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
    globalThis.IntersectionObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof globalThis.IntersectionObserver;
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
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

// The workflow ledger, as the panel sees it — a ref this file drives, because the whole subject is what the
// panel does while it is EMPTY and what it does when the reading comes back.
const runs = ref<WorkflowRun[]>([]);
vi.mock(`../composables/agents/useWorkflowRuns`, async (importOriginal) => ({
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
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
};

// Which chats the panel drew, in column order. Each conversation carries one message naming itself, so the
// columns read out as the chats they are showing — which is the question, and the only one the DOM answers.
const onScreen = (): string[] =>
    [...document.querySelectorAll(`.chat-pane`)].map((pane) => /shows-[a-z]+/.exec(pane.textContent ?? ``)?.[0] ?? `<empty>`);

// A conversation the panel can be asked to show, named so the DOM says which one it is.
const namedChat = (name: string, id?: string) => {
    const chat = useChat();
    const conversation = id === undefined ? chat.newChat() : chat.active.value;
    conversation.restoreMessages([{ role: `user`, text: `shows-${name}` }]);
    return conversation;
};

// A run with one step, on one conversation. `running` is the state that makes the panel follow it.
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
    // Wide enough that the docked panel draws its whole pane set — the shape in which a claimed column is
    // visible at all.
    useLayout().setChatWidth(2000);
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
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

/* THE LATCH. The panel follows the run, the ledger blinks (a daemon rebuild resets the query, an answer has
 * not landed), and the reader picks their own chat during that beat. The pick has to end the follow even
 * though nothing can be looked up about the run — otherwise the next push drags them back, and the one after
 * that, and the reader is left clicking at a window that will not stay where it is put. */
it(`lets go of a run picked away from while the ledger has no reading for it`, async () => {
    const chat = useChat();
    const mine = namedChat(`mine`, chat.activeId.value);

    await mountPanel();
    runs.value = [runWithStep(`running`, `step-1`)];
    showRun(`run-1`, `live`);
    await settle();
    // The panel is following: the step's own conversation took the column.
    expect(chat.panes.value).toEqual([`step-1`]);

    runs.value = []; // the ledger blinks
    await settle();
    chat.setActive(mine.conversationId); // ...and the reader picks their own chat during it
    await settle();
    expect(onScreen()).toEqual([`shows-mine`]);

    runs.value = [runWithStep(`running`, `step-1`)]; // the ledger comes back, the run still going

    await settle();

    expect(chatRun.value).toBeUndefined();
    expect(onScreen()).toEqual([`shows-mine`]);
});

// The same pick with the ledger in hand — the case that always worked, kept so the release cannot be traded
// for the latch a second time.
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

/* A run drives the panes wherever the panel is, so it says so wherever it does — the × is the only thing that
 * ends a follow the reader did not ask to keep, and a docked panel used to draw neither it nor the bar it
 * lives in. */
it(`names the run that is driving it, docked, with the way out`, async () => {
    namedChat(`mine`, useChat().activeId.value);
    await mountPanel();

    runs.value = [runWithStep(`running`, `step-1`)];
    showRun(`run-1`, `live`);
    await settle();

    expect(document.querySelectorAll(`[aria-label="Leave the run"]`).length).toBe(1);
    expect(document.body.textContent).toContain(`Six phases`);
});

/* A COLUMN CLAIMED FOR A CHAT THAT NEVER ARRIVES. openBeside reserves the column before the chat exists (the
 * board's cards open second), so between the claim and the open the id names nothing — and the panel used to
 * fill that column with the focused chat, drawing it twice under one key. */
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
