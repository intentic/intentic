// @vitest-environment jsdom
// Pins the chat bar's close surfaces (card ×, right-click menus) through the real mounted component: which
// chat a menu acts on, where right-click is heard, which rows disable, and that a mass close never confirms.
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
// Statically imported: this graph (app, PrimeVue, router, chat store) compiles too slowly for a hook's timeout,
// but is fine at module load. vitest.setup.ts installs the browser globals it needs before any file loads.
import ChatTabs from "./ChatTabs.vue";
import { installUi } from "@intentic/ui";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { resetChat, useChat } from "../run/useChat";
import { draftConversation, reveal } from "../panel/useChat-reveal";
// The store half of "New agent" (agentActions.startAgent), used as this suite's fixture for extra tabs.
const newChat = () => {
    const conversation = draftConversation();
    reveal({ verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: false });
    return conversation;
};

import { queryClient } from "../../../lib/queryPersistence";
import { router } from "../../../router";

// Globals a mounted chat needs that jsdom lacks: matchMedia (kept desktop via matches:false), window.env,
// ResizeObserver. window.open is stubbed to null; assertions only check that the pop-out row calls it.
const { open } = vi.hoisted(() => {
    // scrollIntoView runs on every focus write and jsdom has none; without this stub a tab switch rejects.
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
    const openWindow = vi.fn(() => null);
    globalThis.window.open = openWindow;
    return { open: openWindow };
});

let strip: HTMLElement;

// Mounted once for the file: ChatTabs registers chat.* commands on mount and a duplicate id throws, so tests
// reset the conversation list instead. installUi (not a stub Icon) since the menu is a real PrimeVue overlay.
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
    // `open` is hoisted once for the module, so its calls accumulate across tests unless cleared here.
    open.mockClear();
    resetChat();
    await nextTick();
    await openSheet();
});

// jsdom reports no transition duration, so Vue tears down a hidden overlay on a timer, not a microtask; without
// this macrotask wait the previous menu's rows are still in the document beside the new one's.
const flush = async (): Promise<void> => {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

// Each tab needs composer text: an untouched "New agent" draft is the one tab useChat won't duplicate, so
// empty presses would collapse into one reused draft. The last one opened ends up active.
const openTabs = (count: number): string[] => {
    const chat = useChat();
    const ids: string[] = [];
    for (let at = 0; at < count; at++) {
        const conversation = at === 0 ? chat.active.value : newChat();
        conversation.draft.value = `pinned ${at}`;
        ids.push(conversation.conversationId);
    }
    return ids;
};

const tabs = (): HTMLElement[] => [...strip.querySelectorAll<HTMLElement>(`[data-chat-tab]`)];
// Cards live in the sheet the header drops, so every test opens it first. Idempotent: the component is mounted
// once for the whole file, so the sheet survives between tests unless a test closed it.
const openSheet = async (): Promise<void> => {
    if (strip.querySelector(`[data-chat-tab]`) === null) {
        strip.querySelector<HTMLElement>(`[data-chat-switcher]`)!.click();
        await flush();
    }
};
// The menu teleports out of the strip, so it's read off the document, not the strip's own subtree.
const menuRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`.p-contextmenu-item`)];
// The row's own label, without the shortcut's `<kbd>`. Selected by the label span's class, not position:
// <ContextMenu> only reserves an icon gutter for menus that use one, shifting the label's child index.
const labelOf = (item: HTMLElement): string => item.querySelector(`a > span.flex-1`)?.textContent?.trim() ?? ``;
const labels = (): string[] => menuRows().map(labelOf);
const row = (label: string): HTMLElement => {
    const found = menuRows().find((item) => labelOf(item) === label);
    expect(found, `menu row "${label}" among [${labels()}]`).toEqual(expect.any(Object));
    return found!;
};
const clickRow = async (label: string): Promise<void> => {
    row(label).querySelector(`a`)!.click();
    await flush();
};
const openMenuOn = async (index: number): Promise<void> => {
    tabs()[index]!.dispatchEvent(new MouseEvent(`contextmenu`, { bubbles: true, cancelable: true }));
    await flush();
};
// A right-click that lands on the bar's chrome rather than a card: the no-card-named gesture.
const openBarMenu = async (): Promise<void> => {
    strip.querySelector<HTMLElement>(`header`)!.dispatchEvent(new MouseEvent(`contextmenu`, { bubbles: true, cancelable: true }));
    await flush();
};
// The +/history pair beside the switcher; right-clicking it is the same bar gesture as elsewhere on the header.
const openMenuOnNewChatButton = async (): Promise<boolean> => {
    const event = new MouseEvent(`contextmenu`, { bubbles: true, cancelable: true });
    strip.querySelector<HTMLElement>(`[aria-label="New agent"]`)!.dispatchEvent(event);
    await flush();
    return event.defaultPrevented; // the strip took the gesture instead of leaving the browser its own menu
};

it(`closes a tab from the × it wears, without selecting it on the way`, async () => {
    const chat = useChat();
    const ids = openTabs(3);
    chat.setActive(ids[0]!);
    await nextTick();

    const target = tabs()[2]!.querySelector<HTMLElement>(`[aria-label="Close chat"]`);
    expect(target).not.toBeNull();
    target!.click();
    await flush();

    expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([ids[0], ids[1]]);
    expect(chat.activeId.value).toBe(ids[0]);
});

it(`closes the set the RIGHT-CLICKED tab names, not the active tab's`, async () => {
    const chat = useChat();
    const ids = openTabs(4); // The last tab is active; every close below is aimed elsewhere.
    await nextTick();
    expect(tabs()).toHaveLength(4);

    // Right-click the second tab: "Close to the Right" takes the two after it, leaving the first two.
    await openMenuOn(1);
    expect(labels()).toEqual([
        `Rename`,
        `Share…`,
        `Close`,
        `Close Others`,
        `Close to the Right`,
        `Close Finished`,
        `Close All`,
        `Move chat into new window`,
    ]);
    await clickRow(`Close to the Right`);

    expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([ids[0], ids[1]]);
    // The active tab was one of the closed ones, so focus falls to the last survivor.
    expect(chat.activeId.value).toBe(ids[1]);

    // Right-click the first tab: "Close Others" keeps that one, not the active one.
    await openMenuOn(0);
    await clickRow(`Close Others`);
    expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([ids[0]]);
    expect(chat.activeId.value).toBe(ids[0]);
});

it(`teaches the shortcut a close command is bound to, and disables the rows with nothing left to take`, async () => {
    openTabs(2);
    await nextTick();

    // The last tab: nothing to its right, but there is still an "other" to close.
    await openMenuOn(1);
    expect(row(`Close Others`).className).not.toContain(`p-disabled`);
    expect(row(`Close to the Right`).className).toContain(`p-disabled`);
    // Every row teaches its own chord: rename on the app-wide F2, closes on the shell-wide tab family shared with
    // the workspace and terminal strips (tabSurface.ts).
    expect(row(`Rename`).querySelector(`kbd`)?.textContent).toBe(`F2`);
    expect(row(`Close All`).querySelector(`kbd`)?.textContent).toBe(`Ctrl+Shift+Backspace`);

    await clickRow(`Close Others`);
    await openMenuOn(0);
    expect(row(`Close Others`).className).toContain(`p-disabled`);
    expect(row(`Close to the Right`).className).toContain(`p-disabled`);
});

it(`offers the card-less rows from the bar's own menu instead of popping out on the right-click itself`, async () => {
    const chat = useChat();
    const ids = openTabs(2);
    await nextTick();

    // Right-click used to toggle the pop-out on the spot; it opens this menu instead, carrying the rows that need
    // no tab under the pointer.
    await openBarMenu();
    expect(labels()).toEqual([`Close Finished`, `Close All`, `Dock chat to rail`, `Move chat into new window`]);
    expect(open).not.toHaveBeenCalled();

    // Close All means here what it means on a tab: the strip comes back as one fresh conversation.
    await clickRow(`Close All`);
    expect(chat.conversations.value).toHaveLength(1);
    expect(chat.conversations.value[0]!.conversationId).not.toBeOneOf(ids);

    // The pop-out row still pops out: the menu is a step in front of the gesture, not a replacement for it.
    await openBarMenu();
    await clickRow(`Move chat into new window`);
    expect(open).toHaveBeenCalledTimes(1);
});

// The pop-out action has no other visible control: it lived behind a right-click that tab chrome ate before
// this button existed. `chat.toggleFloating`'s chord isn't shown since this file mounts the strip alone.
it(`moves the chat into its own window from the strip's own button`, async () => {
    openTabs(2);
    await nextTick();

    const button = strip.querySelector<HTMLElement>(`[aria-label="Move chat into new window"]`);
    expect(button).not.toBeNull();
    button!.click();
    await flush();

    expect(open).toHaveBeenCalledTimes(1);
});

// The +/history buttons don't scroll with the tabs, so the empty-space handler lives on the whole header, not
// the tab scroll box, or right-clicking them fell through to the browser's own menu.
it(`opens the tab menu from the ✚ / history pair beside the strip, not the browser's own`, async () => {
    openTabs(2);
    await nextTick();

    expect(await openMenuOnNewChatButton()).toBe(true);
    expect(labels()).toEqual([`Close Finished`, `Close All`, `Dock chat to rail`, `Move chat into new window`]);
});

// "Clear the done ones" can't be said by Close Others or Close to the Right, since finished tabs are scattered
// among running ones. Finished means what the rail's Finished lane means, so it can't close an Active card.
it(`closes every finished tab and leaves the working ones, disabled when nothing has finished`, async () => {
    const chat = useChat();
    const ids = openTabs(4);
    // Two are done (a plain chat, transcript, no live turn, no board card); the other two are the two ways a tab
    // reads Active: an untouched isolated draft, and a tab mid-turn.
    for (const at of [0, 2]) {
        chat.conversations.value[at]!.isolated.value = false;
        chat.conversations.value[at]!.registered.value = true;
        chat.conversations.value[at]!.restoreMessages([
            { role: `user`, text: `do the thing` },
            { role: `assistant`, text: `done` },
        ]);
    }
    chat.conversations.value[3]!.streaming.value = true;
    await nextTick();

    await openBarMenu();
    await clickRow(`Close Finished`);
    expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([ids[1], ids[3]]);

    await openBarMenu();
    expect(row(`Close Finished`).className).toContain(`p-disabled`);
});

it(`mass closes past a running agent with no confirm: closing detaches from the turn, it doesn't stop it`, async () => {
    const chat = useChat();
    const ids = openTabs(2);
    // The second tab is mid-turn.
    chat.conversations.value[1]!.streaming.value = true;
    await nextTick();

    await openMenuOn(0);
    await clickRow(`Close Others`);

    expect(document.querySelector(`.p-dialog`)).toBeNull();
    expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([ids[0]]);
});
