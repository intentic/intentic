// @vitest-environment jsdom
//
// The open-chat list is a SCROLL BOX — a lane-grouped column of cards, in a sheet the docked header drops or in
// the pop-out rail — and almost nothing that focuses a chat is inside it: a card on /agents, a history row, a
// chord, a brand-new agent appended to the end. Each of those lands on the store's setActive, and unless the
// list follows, the card it is highlighting can sit scrolled out of sight while the panel swaps its transcript
// underneath. The docked case is worse still: the sheet mounts on open, so the card it must show is one that
// was chosen long before this list existed.
// Driven through setActive and through mounting rather than through a mounted /agents board: the board's card,
// the history row and the panel's own select all reach the list through that one write. jsdom lays nothing out,
// so what is asserted is the CALL — which card the list asked to reveal, and that it asked for the cheapest
// scroll (`nearest`, a no-op on a card already visible).
import { VueQueryPlugin } from "@tanstack/vue-query";
import { beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { draftConversation, resetChat, reveal, useChat } from "../composables/chat/useChat";
// The store half of "New agent", as the summons applies it (agentActions.startAgent) — the fixture these
// suites open extra tabs with.
const newChat = () => {
    const conversation = draftConversation();
    reveal({ verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: false });
    return conversation;
};

import { queryClient } from "../composables/queryPersistence";
import { router } from "../router";
import ChatTabList from "./ChatTabList.vue";

// The import-time globals a mounted chat component needs (see startAgent.test.ts), plus the one this file is
// about: jsdom implements no scrollIntoView at all, so it is installed as the recorder the assertions read.
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

// Mounted per test, because MOUNTING is half of what is under test here — the docked sheet is built and torn
// down with every open. The list registers no commands, so nothing objects to being stood up twice.
let app: App | undefined;
const mountList = async (): Promise<void> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    app = createApp({ render: () => h(ChatTabList) });
    app.component(`Icon`, { render: () => null });
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

// The list reveals on the tick AFTER the focus write, so the card it reveals is one the DOM already holds.
const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
};

// Each chat is opened WITH composer text: an untouched "New agent" tab is the one thing the strip won't hold
// two of, so empty presses would collapse into a single reused draft instead of a column of cards.
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

    // The first card is rows above the focus that opening six left on the last one — this is the /agents click.
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

    // Clicking the board card of the chat you are ALREADY in, having scrolled the list elsewhere since. The id
    // doesn't move, so only the store's reveal counter can carry this one.
    chat.setActive(ids[0]!);
    await settle();

    expect(reveals.at(-1)?.tab).toBe(ids[0]);
});

it(`opens already showing the active chat — the docked sheet's whole first frame`, async () => {
    const chat = useChat();
    const ids = openTabs(6);
    chat.setActive(ids[0]!);
    await nextTick();
    reveals.length = 0;

    await mountList(); // the sheet being dropped from the header

    expect(reveals.at(-1)).toEqual({ tab: ids[0], block: `nearest` });
});
