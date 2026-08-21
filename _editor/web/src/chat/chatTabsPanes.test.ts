// @vitest-environment jsdom
//
// THE RAIL'S GESTURES ON THE PANE SET: the popped-out window's left edge is a multi-selecting list (Ctrl adds
// a column, Shift takes a run of rows), and this is what its PLAIN click means: that row, alone.
//
// Driven through the mounted list rather than against the store, because the store verb is not the part that
// was wrong, `chat panes` in useChat.test.ts already pins it. What this file holds is the WIRING: which of
// the click's branches the reset lives in. Put in the wrong one it either fires on a modified click (making
// Ctrl+click a swap and the split unreachable) or fires while DOCKED, where the split is stored but not drawn
// and collapsing one nobody can see quietly loses the arrangement the pop-out returns to.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { resetAgents } from "../composables/agents/useAgents";
import { draftConversation, resetChat, reveal, useChat } from "../composables/chat/useChat";
// The store half of "New agent", as the summons applies it (agentActions.startAgent): the fixture these
// suites open extra tabs with.
const newChat = () => {
    const conversation = draftConversation();
    reveal({ verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: false });
    return conversation;
};

import { useChatPopout } from "../composables/chat/useChatPopout";
import { queryClient } from "../composables/queryPersistence";
import { router } from "../router";
import ChatTabList from "./ChatTabList.vue";

// The import-time globals a mounted chat component needs (see chatTabsLanes.test.ts, which mounts this same
// list): useDevice reads matchMedia at module scope, environment.ts reads window.env, and jsdom implements
// neither ResizeObserver nor the scrollIntoView the list asks for on every focus.
vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

let app: App | undefined;

const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
};

// Wired as ChatPanel wires it: the list emits, the host performs.
const mountList = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    app = createApp({
        render: () =>
            h(ChatTabList, {
                onClose: (ids: ReadonlySet<string>) => useChat().closeTabs(ids),
                onSelect: (id: string) => useChat().setActive(id),
            }),
    });
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
    return el;
};

// Three chats with content, so none of them is the untouched draft the strip reaps under a focus move.
const openThree = (): readonly string[] => {
    const chat = useChat();
    const ids: string[] = [];
    for (let at = 0; at < 3; at++) {
        const conversation = at === 0 ? chat.active.value : newChat();
        conversation.draft.value = `tab ${at}`;
        ids.push(conversation.conversationId);
    }
    chat.setActive(ids[0]!);
    return ids;
};

const row = (el: HTMLElement, id: string): HTMLElement => el.querySelector<HTMLElement>(`[data-chat-tab="${id}"]`)!;

beforeEach(async () => {
    localStorage.clear(); // the tab snapshot persists per sandbox; each test starts from one fresh chat
    resetChat();
    resetAgents();
    useChatPopout().poppedOut.value = true; // panes are offered in the window only
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    useChatPopout().poppedOut.value = false;
    document.body.replaceChildren();
});

it(`collapses the split to the row clicked without a modifier`, async () => {
    const ids = openThree();
    const el = await mountList();

    row(el, ids[1]!).dispatchEvent(new MouseEvent(`click`, { bubbles: true, ctrlKey: true }));
    await settle();
    expect(useChat().panes.value).toEqual([ids[0], ids[1]]);

    row(el, ids[2]!).click();
    await settle();

    expect(useChat().panes.value).toEqual([ids[2]]);
    expect(useChat().activeId.value).toBe(ids[2]);
    // The columns were given back, not closed: every chat is still a row in this list.
    expect(useChat().conversations.value.map((c) => c.conversationId)).toEqual(ids);
});

/* BOTH COLUMNS, ONE MARK. The rail used to rank a split: the focused chat's card at full strength, the rest a
 * step fainter, which asked the reader to read a hierarchy into two chats they had put up to read together.
 * Every chat with a column wears the same card now, and the row for a chat with no column still wears none. */
it(`marks every chat on screen the same, whichever one holds the keyboard`, async () => {
    const ids = openThree();
    const el = await mountList();

    row(el, ids[1]!).dispatchEvent(new MouseEvent(`click`, { bubbles: true, ctrlKey: true }));
    await settle();

    expect(useChat().panes.value).toEqual([ids[0], ids[1]]);
    expect(row(el, ids[0]!).className).toContain(`rail-card-on`);
    expect(row(el, ids[1]!).className).toContain(`rail-card-on`);
    expect(row(el, ids[2]!).className).not.toContain(`rail-card-on`);
});

it(`still gives a row a column of its own when Ctrl says so`, async () => {
    const ids = openThree();
    const el = await mountList();

    row(el, ids[2]!).dispatchEvent(new MouseEvent(`click`, { bubbles: true, ctrlKey: true }));
    await settle();

    expect(useChat().panes.value).toEqual([ids[0], ids[2]]);
});

// Docked, the panel draws the focused chat alone whatever the pane set says, and the pane gestures are not
// offered at all, so a click here is only a focus move, and the split the reader left in the window is theirs
// to come back to.
it(`leaves a stored split alone when the panel is docked`, async () => {
    const ids = openThree();
    useChat().openBeside(ids[1]!);
    useChatPopout().poppedOut.value = false;
    const el = await mountList();

    row(el, ids[2]!).click();
    await settle();

    expect(useChat().panes.value).toEqual([ids[0], ids[2]]);
    expect(useChat().activeId.value).toBe(ids[2]);
});
