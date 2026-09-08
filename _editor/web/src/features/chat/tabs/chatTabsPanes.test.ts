// @vitest-environment jsdom
// Pins which click-handler branch resets the split to a plain click, through the real mounted list; `chat
// panes` in useChat.test.ts already covers the store verb itself.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { resetAgents } from "../../agents/fleet/useAgents";
import { resetChat, useChat } from "../run/useChat";
import { draftConversation, reveal } from "../panel/useChat-reveal";
// Store half of "New agent" (agentActions.startAgent); this suite's fixture for extra tabs.
const newChat = () => {
    const conversation = draftConversation();
    reveal({ verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: false });
    return conversation;
};

import { queryClient } from "../../../lib/queryPersistence";
import { chatFullDock } from "../../../shell/window/dockSlots";
import { router } from "../../../router";
import ChatTabList from "./ChatTabList.vue";
import { IconStub } from "@intentic/ui/testing";

// Globals a mounted chat needs that jsdom lacks: matchMedia, window.env, ResizeObserver, scrollIntoView.
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
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
    return el;
};

// Three chats with content, so none is the untouched draft a focus move would reap.
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
    // A published full-window slot is the wide surface (chatSurface.chatWide); panes are offered only there.
    chatFullDock.value = document.createElement(`div`);
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    chatFullDock.value = null;
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
    // Panes are given back, not closed: every chat is still a row in this list.
    expect(useChat().conversations.value.map((c) => c.conversationId)).toEqual(ids);
});

it(`marks every chat on screen the same, whichever one holds the keyboard`, async () => {
    const ids = openThree();
    const el = await mountList();

    row(el, ids[1]!).dispatchEvent(new MouseEvent(`click`, { bubbles: true, ctrlKey: true }));
    await settle();

    expect(useChat().panes.value).toEqual([ids[0], ids[1]]);
    expect(row(el, ids[0]!).className).toContain(`session-card-on`);
    expect(row(el, ids[1]!).className).toContain(`session-card-on`);
    expect(row(el, ids[2]!).className).not.toContain(`session-card-on`);
});

it(`still gives a row a column of its own when Ctrl says so`, async () => {
    const ids = openThree();
    const el = await mountList();

    row(el, ids[2]!).dispatchEvent(new MouseEvent(`click`, { bubbles: true, ctrlKey: true }));
    await settle();

    expect(useChat().panes.value).toEqual([ids[0], ids[2]]);
});

// Docked, the panel draws only the focused chat and offers no pane gestures, so a click here only moves focus;
// the split stays as the reader left it.
it(`leaves a stored split alone when the panel is docked`, async () => {
    const ids = openThree();
    useChat().openBeside(ids[1]!);
    chatFullDock.value = null;
    const el = await mountList();

    row(el, ids[2]!).click();
    await settle();

    expect(useChat().panes.value).toEqual([ids[0], ids[2]]);
    expect(useChat().activeId.value).toBe(ids[2]);
});
