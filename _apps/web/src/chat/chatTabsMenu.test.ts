// @vitest-environment jsdom
//
// The strip's CLOSE surfaces, driven through the real component: the tab's own × and the right-click menu the
// workspace's file tabs have carried
// Close / Close Others / Close to the Right / Close All for a while, and a chat tab now offers the same set —
// plus Close Finished, which only an agent chat can mean anything by.
// Mounted rather than unit-tested against the store, because the interesting part is the wiring — which tab the
// menu acts on (the RIGHT-CLICKED one, not the active one), where on the strip the right-click is even heard,
// which rows go disabled at the ends of the strip, and that a mass close fires with no confirm even over a
// running agent — closing detaches from the turn (Conversation.abort is soft), it doesn't stop it.
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";

// The import-time globals a mounted chat component needs (see startAgent.test.ts): ui's useDevice reads
// window.matchMedia at module scope, environment.ts reads window.env, and jsdom ships no ResizeObserver.
// matches:false keeps the device DESKTOP — the only form factor this strip renders on.
// window.open is stubbed to null — jsdom opens nothing, and the assertion here is only that the pop-out row
// CALLS it; a real window handed back would send the panel teleporting into a document jsdom never laid out.
const { open } = vi.hoisted(() => {
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
let useChat: typeof import("../composables/chat/useChat").useChat;
let resetChat: typeof import("../composables/chat/useChat").resetChat;

// Mounted ONCE for the file: ChatTabs registers the chat.* commands on mount and the registry throws on a
// duplicate id, so each test resets the conversation list instead of remounting. installUi rather than
// startAgent.test.ts's stub Icon — the menu IS a PrimeVue overlay, so it needs the real plugin. vue-query goes
// on too: the strip carries the agents filter, whose daemon tier is a useQuery.
// `onClose` stands in for ChatPanel, which hands the emitted set straight to the store's closeTabs.
beforeAll(async () => {
    const ChatTabs = (await import(`./ChatTabs.vue`)).default;
    const { installUi } = await import(`@intentic-app/ui`);
    const { VueQueryPlugin } = await import(`@tanstack/vue-query`);
    const { queryClient } = await import(`../composables/queryPersistence`);
    const { router } = await import(`../router`);
    ({ useChat, resetChat } = await import(`../composables/chat/useChat`));

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
        const conversation = at === 0 ? chat.active.value : chat.newChat();
        conversation.draft.value = `pinned ${at}`;
        ids.push(conversation.conversationId);
    }
    return ids;
};

const tabs = (): HTMLElement[] => [...strip.querySelectorAll<HTMLElement>(`[data-chat-tab]`)];
// The menu teleports out of the strip, so it is read off the document rather than the strip's own subtree.
const menuRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`.p-contextmenu-item`)];
// The row's own label, without the shortcut hint the same <a> carries in a <kbd>.
const labelOf = (item: HTMLElement): string => item.querySelector(`a > span:nth-child(2)`)?.textContent?.trim() ?? ``;
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
// The scroll box the tabs sit in: a right-click that lands on IT rather than on a tab is the empty-space gesture.
const openStripMenu = async (): Promise<void> => {
    strip.querySelector<HTMLElement>(`header > div`)!.dispatchEvent(new MouseEvent(`contextmenu`, { bubbles: true, cancelable: true }));
    await flush();
};
// The ✚ / history pair, which lives OUTSIDE the scroll box (it must not scroll with the tabs). Right-clicking it
// is the same tab-management gesture as right-clicking the strip's gap — it just used to land on nothing.
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

it(`offers the tab-less rows from the empty strip's menu instead of popping out on the right-click itself`, async () => {
    const chat = useChat();
    const ids = openTabs(2);
    await nextTick();

    // The gesture used to toggle the pop-out on the spot, which tore the panel into its own window on a
    // right-click that only just missed a tab. It opens the menu now, carrying the rows that need no tab
    // under the pointer; the pop-out is one of them.
    await openStripMenu();
    expect(labels()).toEqual([`Close Finished`, `Close All`, `Move chat into new window`]);
    expect(open).not.toHaveBeenCalled();

    // Close All means here what it means on a tab: the strip comes back as one fresh conversation.
    await clickRow(`Close All`);
    expect(chat.conversations.value).toHaveLength(1);
    expect(chat.conversations.value[0]!.conversationId).not.toBeOneOf(ids);

    // The pop-out row still pops out — the menu is a step in front of the gesture, not a replacement for it.
    await openStripMenu();
    await clickRow(`Move chat into new window`);
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
        chat.conversations.value[at]!.restoreMessages([
            { role: `user`, text: `do the thing` },
            { role: `assistant`, text: `done` },
        ]);
    }
    chat.conversations.value[3]!.streaming.value = true;
    await nextTick();

    await openStripMenu();
    await clickRow(`Close Finished`);
    expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([ids[1], ids[3]]);

    // Nothing left that has finished: the row goes disabled rather than quietly closing nothing.
    await openStripMenu();
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
