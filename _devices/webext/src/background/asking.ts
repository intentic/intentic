import { within } from "@intentic/base/async";
import { askConfirm, dismissConfirm } from "../page/overlay.js";
import { originPattern } from "./policy.js";
import { store } from "./store.js";
import { openPanel, refreshBadge } from "./tools/access.js";
import { inject } from "./tools/page.js";

// The person's yes, asked where the agent works (2026-10-28). The question renders in the page itself, beside what it
// is about (page/overlay.ts). With the agent in its own window behind theirs that page is out of sight, so the same
// question is put on the extension's icon too: the badge, and the popup, which opens by itself when they allow that
// ("Pop up when my agent asks") and can answer it. The agent's window flashes in the taskbar, which moves no focus
// (measured on Brave 156). Whichever answers first, the panel on the page or the popup, is the answer, and the panel
// is then taken down. The popup is this extension's own page: neither the agent nor any site can click in it.

// Spare time past the page's own timeout, for its "no" to arrive before this side stops waiting for it.
const PAGE_GRACE_MS = 5000;

// The popup's answer to a question still being asked, by its id. Lives exactly as long as the tool call that asked,
// which is the worker's own: a worker that died took the call with it, and `clearStaleAsking` drops what it left stored.
const waiting = new Map<string, (allow: boolean) => void>();

// The window to flash when the tab is out of the person's sight: not the tab in front of the browser window they are
// using. A window Chrome calls focused is the one they last used, even while another program is in front of it.
const outOfSight = async (tabId: number): Promise<number | undefined> => {
    // allow(silent-catch): a tab or window that closed meanwhile has nothing to flash; the question is still asked
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab?.windowId === undefined) {
        return undefined;
    }
    // allow(silent-catch): as above, for the window
    const window = await chrome.windows.get(tab.windowId).catch(() => undefined);
    const inSight = window !== undefined && window.focused && window.state !== "minimized" && tab.active === true;
    return inSight ? undefined : tab.windowId;
};

const flash = (windowId: number, on: boolean): void => {
    // allow(silent-catch): flashing is a courtesy; a window that closed meanwhile has nothing to flash
    void chrome.windows.update(windowId, { drawAttention: on }).catch(() => undefined);
};

// Asks the person `question` about `tab`, and resolves to their answer: no when nobody answers within `timeoutMs`.
// Rejects as `inject` does when the page goes away before it could ask.
export const askPerson = async (tab: { readonly id: number; readonly url: string }, question: string, timeoutMs: number): Promise<boolean> => {
    const id = crypto.randomUUID();
    const fromPopup = new Promise<boolean>((resolve) => {
        waiting.set(id, resolve);
    });
    await store.setAsking({ id, tabId: tab.id, origin: originPattern(tab.url) ?? tab.url, question, at: Date.now() });
    await refreshBadge();
    const hidden = await outOfSight(tab.id);
    if (hidden !== undefined) {
        flash(hidden, true);
        await openPanel();
    }
    const onPage = inject(tab.id, askConfirm, [question, timeoutMs, id]);
    // allow(silent-catch): marks a page that went away after the popup answered as handled; the race below still sees it
    void onPage.catch(() => undefined);
    try {
        return await within(Promise.race([onPage, fromPopup]), timeoutMs + PAGE_GRACE_MS, false);
    } finally {
        waiting.delete(id);
        if ((await store.asking())?.id === id) {
            await store.setAsking(undefined);
        }
        await refreshBadge();
        // allow(silent-catch): a page that navigated has no panel left to take down
        void chrome.scripting.executeScript({ target: { tabId: tab.id }, func: dismissConfirm, args: [id] }).catch(() => undefined);
        if (hidden !== undefined) {
            flash(hidden, false);
        }
    }
};

// The popup's Allow or No for question `id`. False when nothing is asking it any more, which also clears a question
// left stored by a worker that died mid-ask.
export const answerAsking = async (id: string, allow: boolean): Promise<boolean> => {
    const settle = waiting.get(id);
    if (settle === undefined) {
        await clearStaleAsking();
        return false;
    }
    settle(allow);
    return true;
};

// On a worker's start: a question stored by one that died is asked by nobody, and its badge and card would wait forever.
export const clearStaleAsking = async (): Promise<void> => {
    const stored = await store.asking();
    if (stored !== undefined && !waiting.has(stored.id)) {
        await store.setAsking(undefined);
        await refreshBadge();
    }
};
