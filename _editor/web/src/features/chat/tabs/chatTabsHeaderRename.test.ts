// @vitest-environment jsdom
// The bar's title field renames the chat it opened on, and only that one. Regression: a summons from another
// window switches the active chat without blurring the field, so a commit landed on whichever chat had since
// become active.
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
// Statically imported: this graph (app, PrimeVue, router, chat store) compiles too slowly for a hook's timeout.
import ChatTabs from "./ChatTabs.vue";
import { installUi } from "@intentic/ui";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { resetChat, useChat } from "../run/useChat";
import { draftConversation, reveal } from "../panel/useChat-reveal";
import { queryClient } from "../../../lib/queryPersistence";
import { router } from "../../../router";

vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
    globalThis.window.open = vi.fn(() => null);
});

let strip: HTMLElement;

// Mounted once for the file: ChatTabs registers chat.* commands on mount and a duplicate id throws.
beforeAll(() => {
    strip = document.createElement(`div`);
    document.body.appendChild(strip);
    const app = createApp({ render: () => h(ChatTabs, { onClose: (ids: ReadonlySet<string>) => useChat().closeTabs(ids) }) });
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    installUi(app);
    app.mount(strip);
});

beforeEach(async () => {
    localStorage.clear(); // the tab snapshot persists per sandbox; each test starts from one fresh chat
    resetChat();
    await settle();
});

const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
    await nextTick();
};

// The store half of a summons arriving from another window: it opens the chat and takes the focus. The chat on
// screen is given words first, since an untouched draft is handed back instead of a second one being minted.
const summon = async (): Promise<string> => {
    useChat().active.value.draft.value = `pinned`;
    const conversation = draftConversation();
    reveal({ verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: false });
    await settle();
    return conversation.conversationId;
};

const field = (): HTMLInputElement | null => strip.querySelector<HTMLInputElement>(`input[aria-label="Chat title"]`);

const openField = async (): Promise<void> => {
    strip.querySelector<HTMLElement>(`[data-chat-switcher]`)?.dispatchEvent(new MouseEvent(`dblclick`, { bubbles: true }));
    await settle();
};

it(`opens on a double-click of the chat's name`, async () => {
    await openField();

    expect(field()).not.toBeNull();
});

it(`closes when another window switches the chat under it`, async () => {
    await openField();
    const before = useChat().activeId.value;

    const focused = await summon();

    expect(focused).not.toBe(before);
    expect(field()).toBeNull();
});
