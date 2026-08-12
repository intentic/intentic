// @vitest-environment jsdom
//
// The chat bar's CLOSE surfaces, driven through the real component: a card's own × and the right-click menu the
// workspace's file tabs have carried
// Close / Close Others / Close to the Right / Close All for a while, and a chat now offers the same set —
// plus Close Finished, which only an agent chat can mean anything by.
// Mounted rather than unit-tested against the store, because the interesting part is the wiring — which chat the
// menu acts on (the RIGHT-CLICKED one, not the active one), where on the bar the right-click is even heard,
// which rows go disabled at the ends of the list, and that a mass close fires with no confirm even over a
// running agent — closing detaches from the turn (Conversation.abort is soft), it doesn't stop it.
// There are TWO menus now, which is the split the surfaces made: cards live in the sheet the header drops and
// carry their own (acting on the card under the pointer), while the header's chrome carries the sweeps that
// name no card at all.
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
// Statically imported, not awaited inside the hook: this graph is the whole app's — PrimeVue, the router, the
// chat store — and compiling it cold takes longer than a hook is allowed to (vitest's hookTimeout), where the
// same work at import time is simply the file's load. The globals below still land first; vi.hoisted runs
// above every import in the transformed module, which is exactly what it is for.
import ChatTabs from "./ChatTabs.vue";
import { installUi } from "@intentic/ui";
import { VueQueryPlugin } from "@tanstack/vue-query";
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

// The import-time globals a mounted chat component needs (see startAgent.test.ts): ui's useDevice reads
// window.matchMedia at module scope, environment.ts reads window.env, and jsdom ships no ResizeObserver.
// matches:false keeps the device DESKTOP — the only form factor this strip renders on.
// window.open is stubbed to null — jsdom opens nothing, and the assertion here is only that the pop-out row
// CALLS it; a real window handed back would send the panel teleporting into a document jsdom never laid out.
const { open } = vi.hoisted(() => {
    // The strip scrolls its focused tab back into view on every focus write, and jsdom implements no
    // scrollIntoView — without this stub every tab switch below ends in an unhandled rejection.
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
    globalThis.ResizeObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
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
    const openWindow = vi.fn(() => null);
    globalThis.window.open = openWindow;
    return { open: openWindow };
});

let strip: HTMLElement;

// Mounted ONCE for the file: ChatTabs registers the chat.* commands on mount and the registry throws on a
// duplicate id, so each test resets the conversation list instead of remounting. installUi rather than
// startAgent.test.ts's stub Icon — the menu IS a PrimeVue overlay, so it needs the real plugin. vue-query goes
// on too: the strip carries the agents filter, whose daemon tier is a useQuery.
// `onClose` stands in for ChatPanel, which hands the emitted set straight to the store's closeTabs.
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
    await nextTick();
    await openSheet();
});

// jsdom reports no transition duration, so Vue tears a hidden overlay down on a TIMER rather than a microtask —
// without a macrotask wait the previous menu's rows are still in the document beside the new menu's.
const flush = async (): Promise<void> => {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

// Tabs here exist to be closed by the MENU, so each is opened WITH composer text. An untouched "New agent" tab
// is the one thing the strip won't hold two of (useChat's setConversations keeps at most one, and only as the
// focused tab), so four empty presses would collapse into a single reused draft; and a closed tab has to be a
// tab first. The last one opened is the active one, the way a press leaves it.
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
/* Cards live in the SHEET the header drops, so every test here opens it first — the bar itself is one line
 * naming the active chat. Idempotent, and it has to be: the component is mounted once for the whole file, so
 * the sheet survives between tests unless something in one of them closed it. */
const openSheet = async (): Promise<void> => {
    if (strip.querySelector(`[data-chat-tab]`) === null) {
        strip.querySelector<HTMLElement>(`[data-chat-switcher]`)!.click();
        await flush();
    }
};
// The menu teleports out of the strip, so it is read off the document rather than the strip's own subtree.
const menuRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`.p-contextmenu-item`)];
/* The row's own label, without the shortcut hint the same <a> carries in a <kbd>. Selected by the label span's
 * own class rather than by position: <ContextMenu> reserves the leading icon/check gutter only for menus whose
 * model actually uses one, so the label is the first child in the strip menu (no icons anywhere) and the second
 * in the tab menu (Rename and Close carry one). Which of those a menu is, is not what these tests are about. */
const labelOf = (item: HTMLElement): string => item.querySelector(`a > span.flex-1`)?.textContent?.trim() ?? ``;
const labels = (): string[] => menuRows().map(labelOf);
const row = (label: string): HTMLElement => {
    const found = menuRows().find((item) => labelOf(item) === label);
    expect(found, `menu row "${label}" among [${labels()}]`).toBeDefined();
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
// The bar's own chrome: a right-click that lands on IT rather than on a card is the no-card-named gesture.
const openBarMenu = async (): Promise<void> => {
    strip.querySelector<HTMLElement>(`header`)!.dispatchEvent(new MouseEvent(`contextmenu`, { bubbles: true, cancelable: true }));
    await flush();
};
// The ✚ / history pair beside the switcher. Right-clicking it is the same chat-management gesture as
// right-clicking anywhere else on the bar — it just used to land on nothing.
const openMenuOnNewChatButton = async (): Promise<boolean> => {
    const event = new MouseEvent(`contextmenu`, { bubbles: true, cancelable: true });
    strip.querySelector<HTMLElement>(`[aria-label="New agent"]`)!.dispatchEvent(event);
    await flush();
    return event.defaultPrevented; // the strip took the gesture instead of leaving the browser its own menu
};

/* The × the tab wears is a HIT TARGET carrying the glyph, not the glyph with a handler on it: at text-2xs the
 * svg is an 11px square, and a click that misses one lands on the tab instead — which, on the tab being closed
 * (the one the user is looking at), selects an already-selected tab and so reads as a close that did nothing.
 * The reachable size is layout, which jsdom has none of; what is assertable here is that the target exists as its
 * own labelled element and that hitting it closes THAT tab without also selecting it. */
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
    expect(chat.activeId.value).toBe(ids[0]); // the click never reached the tab under it
});

it(`closes the set the RIGHT-CLICKED tab names, not the active tab's`, async () => {
    const chat = useChat();
    const ids = openTabs(4); // the LAST tab is active — every close below is aimed elsewhere
    await nextTick();
    expect(tabs()).toHaveLength(4);

    // Right-click the second tab: "Close to the Right" takes the two after it, leaving the first two.
    await openMenuOn(1);
    expect(labels()).toEqual([`Rename`, `Close`, `Close Others`, `Close to the Right`, `Close Finished`, `Close All`, `Move chat into new window`]);
    await clickRow(`Close to the Right`);

    expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([ids[0], ids[1]]);
    // The active tab was one of the closed ones, so focus falls to the last survivor.
    expect(chat.activeId.value).toBe(ids[1]);

    // Right-click the FIRST tab: "Close Others" keeps that one, not the active one.
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
    // Every row teaches its chord: rename on the app-wide F2, the closes on the shell-wide tab family the
    // workspace and terminal strips register too (tabSurface.ts) — the chat's were unbound until it joined it.
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

    // The gesture used to toggle the pop-out on the spot, which tore the panel into its own window on a
    // right-click that only just missed a tab. It opens the menu now, carrying the rows that need no tab
    // under the pointer; the pop-out is one of them.
    await openBarMenu();
    expect(labels()).toEqual([`Close Finished`, `Close All`, `Move chat into new window`]);
    expect(open).not.toHaveBeenCalled();

    // Close All means here what it means on a tab: the strip comes back as one fresh conversation.
    await clickRow(`Close All`);
    expect(chat.conversations.value).toHaveLength(1);
    expect(chat.conversations.value[0]!.conversationId).not.toBeOneOf(ids);

    // The pop-out row still pops out — the menu is a step in front of the gesture, not a replacement for it.
    await openBarMenu();
    await clickRow(`Move chat into new window`);
    expect(open).toHaveBeenCalled();
});

/* THE POP-OUT'S OWN BUTTON, beside the ✚ / history pair. The action had no visible control at all: it lived
 * behind a right-click on strip chrome that the tabs themselves eat (they `grow` into every pixel of slack), so
 * the target shrank as sessions were opened — hardest to hit exactly when a floating chat is most wanted. The
 * label doubles as the tooltip and carries the chord once one is bound, which is not the case here: this file
 * mounts the strip alone, and `chat.togglePopout` belongs to the shell's registration. */
it(`moves the chat into its own window from the strip's own button`, async () => {
    openTabs(2);
    await nextTick();

    const button = strip.querySelector<HTMLElement>(`[aria-label="Move chat into new window"]`);
    expect(button).not.toBeNull();
    button!.click();
    await flush();

    expect(open).toHaveBeenCalled();
});

/* The ✚ and history buttons are siblings of the tab scroll box — they stay put while the tabs scroll — so the
 * empty-space handler used to sit on the box and miss them entirely: the one patch of the strip that looks like
 * tab chrome and behaved like a web page, handing back the browser's own menu. The handler lives on the whole
 * header now. */
it(`opens the tab menu from the ✚ / history pair beside the strip, not the browser's own`, async () => {
    openTabs(2);
    await nextTick();

    expect(await openMenuOnNewChatButton()).toBe(true);
    expect(labels()).toEqual([`Close Finished`, `Close All`, `Move chat into new window`]);
});

/* "Clear the done ones" is the sweep a long session actually wants, and neither Close Others nor Close to the
 * Right can say it: the finished tabs are scattered through the strip between the running ones. Finished means
 * exactly what the rail's Finished lane means — has messages, isn't streaming (or, for a fleet-carded tab, the
 * board's own lane) — so the row can't close a card the rail still shows as Active. */
it(`closes every finished tab and leaves the working ones, disabled when nothing has finished`, async () => {
    const chat = useChat();
    const ids = openTabs(4);
    // Two are done: a plain (non-isolated) chat with a transcript and no live turn — no card on the board, and
    // nothing running. The other two are the two ways a tab reads as Active: an untouched isolated draft (which
    // the fleet cards as `draft`) and a tab mid-turn.
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

    // Nothing left that has finished: the row goes disabled rather than quietly closing nothing.
    await openBarMenu();
    expect(row(`Close Finished`).className).toContain(`p-disabled`);
});

it(`mass closes past a running agent with no confirm — closing detaches from the turn, it doesn't stop it`, async () => {
    const chat = useChat();
    const ids = openTabs(2);
    // The second tab is mid-turn. Its run is detached daemon-side, so closing the tab leaves the agent working
    // and the chat reopenable from History mid-turn — there is nothing to warn about.
    chat.conversations.value[1]!.streaming.value = true;
    await nextTick();

    await openMenuOn(0);
    await clickRow(`Close Others`);

    expect(document.querySelector(`.p-dialog`)).toBeNull();
    expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([ids[0]]);
});
