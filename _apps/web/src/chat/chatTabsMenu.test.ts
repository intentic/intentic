// @vitest-environment jsdom
//
// The strip's right-click menu, driven through the real component: the workspace's file tabs have carried
// Close / Close Others / Close to the Right / Close All for a while, and a chat tab now offers the same set.
// Mounted rather than unit-tested against the store, because the interesting part is the wiring — which tab the
// menu acts on (the RIGHT-CLICKED one, not the active one), which rows go disabled at the ends of the strip, and
// that a mass close with a running agent in it stops at a confirm instead of aborting the turn.
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";

// The import-time globals a mounted chat component needs (see startAgent.test.ts): ui's useDevice reads
// window.matchMedia at module scope, environment.ts reads window.env, and jsdom ships no ResizeObserver.
// matches:false keeps the device DESKTOP — the only form factor this strip renders on.
// documentPictureInPicture is read once at module scope too (usePopout's `supported`), so the stub has to be in
// place before the import — without it the strip would render as it does on Firefox, with no pop-out row at all.
// requestWindow never settles: the assertion is only that the row CALLS it, and a resolved undefined would send
// popOut on into a pip document that isn't there.
const { requestWindow } = vi.hoisted(() => {
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
    const pipApi = { requestWindow: vi.fn(() => new Promise<Window>(() => {})) };
    (globalThis.window as Window & { documentPictureInPicture?: unknown }).documentPictureInPicture = pipApi;
    return pipApi;
});

let strip: HTMLElement;
let useChat: typeof import("../composables/chat/useChat").useChat;
let resetChat: typeof import("../composables/chat/useChat").resetChat;

// Mounted ONCE for the file: ChatTabs registers the chat.* commands on mount and the registry throws on a
// duplicate id, so each test resets the conversation list instead of remounting. installUi rather than
// startAgent.test.ts's stub Icon — the menu and its confirm ARE PrimeVue overlays, so they need the real plugin.
// `onClose` is the one line ChatPanel adds around the store call (it also re-pins the transcript scroller).
beforeAll(async () => {
    const ChatTabs = (await import(`./ChatTabs.vue`)).default;
    const { installUi } = await import(`@intentic-app/ui`);
    const { router } = await import(`../router`);
    ({ useChat, resetChat } = await import(`../composables/chat/useChat`));

    strip = document.createElement(`div`);
    document.body.appendChild(strip);
    const app = createApp({ render: () => h(ChatTabs, { onClose: (ids: ReadonlySet<string>) => useChat().closeTabs(ids) }) });
    app.use(router);
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

it(`closes the set the RIGHT-CLICKED tab names, not the active tab's`, async () => {
    const chat = useChat();
    const ids = [chat.active.value.id, chat.newChat().id, chat.newChat().id, chat.newChat().id];
    chat.setActive(ids[3]!); // the LAST tab is active — every close below is aimed elsewhere
    await nextTick();
    expect(tabs()).toHaveLength(4);

    // Right-click the second tab: "Close to the Right" takes the two after it, leaving the first two.
    await openMenuOn(1);
    expect(labels()).toEqual([`Rename`, `Close`, `Close Others`, `Close to the Right`, `Close All`, `Move chat into new window`]);
    await clickRow(`Close to the Right`);

    expect(chat.conversations.value.map((c) => c.id)).toEqual([ids[0], ids[1]]);
    // The active tab was one of the closed ones, so focus falls to the last survivor.
    expect(chat.activeId.value).toBe(ids[1]);

    // Right-click the FIRST tab: "Close Others" keeps that one, not the active one.
    await openMenuOn(0);
    await clickRow(`Close Others`);
    expect(chat.conversations.value.map((c) => c.id)).toEqual([ids[0]]);
    expect(chat.activeId.value).toBe(ids[0]);
});

it(`teaches the shortcut a close command is bound to, and disables the rows with nothing left to take`, async () => {
    const chat = useChat();
    chat.newChat();
    await nextTick();

    // The last tab: nothing to its right, but there is still an "other" to close.
    await openMenuOn(1);
    expect(row(`Close Others`).className).not.toContain(`p-disabled`);
    expect(row(`Close to the Right`).className).toContain(`p-disabled`);
    // Rename ships on F2 and the row says so; the closes ship unbound, so their hint slot stays empty until the
    // user binds one in Settings → Keybindings.
    expect(row(`Rename`).querySelector(`kbd`)?.textContent).toBe(`F2`);
    expect(row(`Close All`).querySelector(`kbd`)).toBeNull();

    await clickRow(`Close Others`);
    await openMenuOn(0);
    expect(row(`Close Others`).className).toContain(`p-disabled`);
    expect(row(`Close to the Right`).className).toContain(`p-disabled`);
});

it(`offers the tab-less rows from the empty strip's menu instead of popping out on the right-click itself`, async () => {
    const chat = useChat();
    const ids = [chat.active.value.id, chat.newChat().id];
    await nextTick();

    // The gesture used to toggle the pop-out on the spot, which tore the panel into its own window on a
    // right-click that only just missed a tab. It opens the menu now, carrying the rows that need no tab
    // under the pointer; the pop-out is one of them.
    await openStripMenu();
    expect(labels()).toEqual([`Close All`, `Move chat into new window`]);
    expect(requestWindow).not.toHaveBeenCalled();

    // Close All means here what it means on a tab: the strip comes back as one fresh conversation.
    await clickRow(`Close All`);
    expect(chat.conversations.value).toHaveLength(1);
    expect(chat.conversations.value[0]!.id).not.toBeOneOf(ids);

    // The pop-out row still pops out — the menu is a step in front of the gesture, not a replacement for it.
    await openStripMenu();
    await clickRow(`Move chat into new window`);
    expect(requestWindow).toHaveBeenCalled();
});

it(`holds a mass close at a confirm when it would abort a running agent`, async () => {
    const chat = useChat();
    const ids = [chat.active.value.id, chat.newChat().id];
    // The second tab is mid-turn: closing it aborts an agent that is still working, which is why the mass closes
    // ask first (the single × doesn't — that tab is on screen, pulsing).
    chat.conversations.value[1]!.streaming.value = true;
    await nextTick();

    await openMenuOn(0);
    await clickRow(`Close Others`);

    // Still two tabs: the confirm is up and nothing has been closed yet.
    expect(chat.conversations.value.map((c) => c.id)).toEqual(ids);
    expect(document.querySelector(`.p-dialog`)?.textContent).toContain(`Stop the running agent?`);

    [...document.querySelectorAll<HTMLElement>(`.p-dialog button`)].find((button) => button.textContent?.includes(`Close anyway`))!.click();
    await flush();
    expect(chat.conversations.value.map((c) => c.id)).toEqual([ids[0]]);
});
