// @vitest-environment jsdom
// Pins that any focus write (board card, history row, chord, new agent) scrolls the list's card into view via
// `nearest`, including the docked sheet's first frame after mount.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { resetChat, useChat } from "../run/useChat";
import { draftConversation, reveal } from "../panel/useChat-reveal";
// Store half of "New agent" (agentActions.startAgent); this suite's fixture for extra tabs.
const newChat = () => {
    const conversation = draftConversation();
    reveal({ verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: false });
    return conversation;
};

import { queryClient } from "../../../lib/queryPersistence";
import { router } from "../../../router";
import ChatTabList from "./ChatTabList.vue";
import { IconStub } from "@intentic/ui/testing";

// jsdom has no scrollIntoView; installed here as the recorder the assertions read.
const { reveals } = vi.hoisted(() => {
    const recorded: { tab: string | undefined; block: string | undefined }[] = [];
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(this: Element, options?: boolean | ScrollIntoViewOptions): void {
        recorded.push({
            tab: this instanceof HTMLElement ? this.dataset[`chatTab`] : undefined,
            block: typeof options === `object` ? options.block : undefined,
        });
    };
    return { reveals: recorded };
});

// Mounted per test since mounting itself is under test (the docked sheet rebuilds on every open); registers
// no commands, so remounting is safe.
let app: App | undefined;
const mountList = async (): Promise<void> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    app = createApp({ render: () => h(ChatTabList) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
};

beforeEach(async () => {
    app?.unmount();
    app = undefined;
    localStorage.clear(); // the tab snapshot persists per sandbox; each test starts from one fresh chat
    resetChat();
    reveals.length = 0;
    await nextTick();
});

// Reveals fire a tick after the focus write, once the DOM already holds the card.
const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
};

// Each tab opens with composer text, since an untouched draft is the one tab useChat won't duplicate.
const openTabs = (count: number): string[] => {
    const chat = useChat();
    return Array.from({ length: count }, (_unused, at) => {
        const conversation = at === 0 ? chat.active.value : newChat();
        conversation.draft.value = `pinned ${at}`;
        return conversation.conversationId;
    });
};

it(`scrolls a chat focused from outside the list back into view`, async () => {
    const chat = useChat();
    const ids = openTabs(6);
    await mountList();
    reveals.length = 0;

    // ids[0] is scrolled away: opening six left the focus on the last one.
    chat.setActive(ids[0]!);
    await settle();

    expect(reveals.at(-1)).toEqual({ tab: ids[0], block: `nearest` });
});

it(`reveals again when the chat already in focus is selected once more`, async () => {
    const chat = useChat();
    const ids = openTabs(6);
    chat.setActive(ids[0]!);
    await mountList();
    reveals.length = 0;

    // Same id as before; only the reveal counter (not the id) can signal this.
    chat.setActive(ids[0]!);
    await settle();

    expect(reveals.at(-1)?.tab).toBe(ids[0]);
});

it(`opens already showing the active chat: the docked sheet's whole first frame`, async () => {
    const chat = useChat();
    const ids = openTabs(6);
    chat.setActive(ids[0]!);
    await nextTick();
    reveals.length = 0;

    await mountList(); // the sheet being dropped from the header

    expect(reveals.at(-1)).toEqual({ tab: ids[0], block: `nearest` });
});
