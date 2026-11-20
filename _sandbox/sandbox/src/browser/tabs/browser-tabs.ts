import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserPageAction, OpenBrowserResult } from "@intentic/sandbox-contract/schemas/terminal";
import type { Page } from "playwright";
import { takeClosed } from "../state/closed-tabs.js";
import { shownUrl, wakeDeferred } from "../state/deferred-tabs.js";
import { pageTargetId } from "../state/page-favicon.js";
import { indexAmong, moveEntry } from "../state/tab-order.js";
import { windowChanged } from "../state/window-feed.js";
import type { BrowserSessionRecord, PageRecord } from "../state/window-record.js";
import { openWindow } from "../state/window-registry.js";
import { browserSessionBlankPage, browserSessionNewTab, pickBrowserPage } from "../sessions/browser-sessions.js";
import type { OwnTabs } from "./own-tabs.js";
import type { TabHelper } from "./tab-helper.js";

// WHAT A TAB'S OWN MENU DOES, and a restore: reopening a closed tab at the place it had, moving a tab along the strip, a
// copy of a tab, reloading one that is not in front, muting one, and bringing the person's own window back as it stood.
// Each acts on the window's record and says so through the window's feed, so every viewer's strip moves at once. Where
// the window carries the tab helper (tab-helper.ts, the person's own), a reopen and a copy go through Chromium's own tab
// model and keep the tab's back and forward; elsewhere, and whenever the helper cannot, the tab is opened fresh at the
// same address.

// How long a tab Chromium was asked to open (a restore, a copy) is waited for before the fresh-tab way is taken.
const OPEN_WAIT_MS = 3000;
// How long a tab's own record is waited for once the window has the page: its `page` event registers it.
const RECORD_TICKS = 20;
const RECORD_TICK_MS = 25;

const isOpen = (entry: PageRecord): boolean => !entry.closed;

// The record a page became, once the window's `page` event has registered it; undefined if it never does.
const recordOf = async (record: BrowserSessionRecord, page: Page): Promise<PageRecord | undefined> => {
    for (let tick = 0; tick < RECORD_TICKS; tick += 1) {
        const found = [...record.pages.values()].find((entry) => entry.page === page);
        if (found !== undefined) {
            return found;
        }
        // waiting on one event, a handful of ticks at most
        await sleep(RECORD_TICK_MS);
    }
    return undefined;
};

// The tab Chromium opens while `act` runs, when it says it opened one.
const tabOpenedBy = async (record: BrowserSessionRecord, act: () => Promise<boolean>): Promise<PageRecord | undefined> => {
    const context = record.context;
    if (context === undefined) {
        return undefined;
    }
    // allow(silent-catch): no tab within the wait is the helper not having opened one; the fresh-tab way follows.
    const opened = context.waitForEvent("page", { timeout: OPEN_WAIT_MS }).catch(() => undefined);
    if (!(await act())) {
        return undefined;
    }
    const page = await opened;
    return page === undefined ? undefined : recordOf(record, page);
};

// A new tab sent to `url`, not awaited past setting off.
const freshTab = async (name: string, url: string): Promise<string | undefined> => {
    const tab = await browserSessionNewTab(name);
    // allow(silent-catch): an address that no longer answers is Chromium's own error page, which the tab then shows.
    void tab?.page.goto(url, { waitUntil: "commit" }).catch(() => undefined);
    return tab?.id;
};

// A tab just opened, put at `index` and in front, as a browser puts a reopened tab or a copy.
const placeInFront = async (record: BrowserSessionRecord, id: string, index: number): Promise<OpenBrowserResult> => {
    moveEntry(record.pages, id, index, isOpen);
    await pickBrowserPage(record.name, id);
    windowChanged(record, true);
    return { name: record.name, pageId: id };
};

// Brings back the closed tab asked for (the newest when none is named) at the place it had, in front; answers the tab,
// or the window alone when there was nothing to bring back.
export const reopenClosedTab = async (name: string, closedId: string | undefined): Promise<OpenBrowserResult> => {
    const record = openWindow(name);
    const taken = takeClosed(record?.closed, closedId);
    if (record === undefined || taken === undefined) {
        return { name };
    }
    record.closed = taken.rest;
    const { tab } = taken;
    const helper = record.helper;
    const restored = helper === undefined ? undefined : await tabOpenedBy(record, () => helper.restore(tab.url));
    const id = restored?.id ?? (await freshTab(name, tab.url));
    if (id === undefined) {
        windowChanged(record);
        return { name };
    }
    return placeInFront(record, id, tab.index);
};

// Puts one tab at `index` among the window's open tabs; whether it moved.
export const moveTab = (name: string, pageId: string, index: number): boolean => {
    const record = openWindow(name);
    if (record === undefined || !moveEntry(record.pages, pageId, index, isOpen)) {
        return false;
    }
    windowChanged(record, true);
    return true;
};

// A copy of a tab right after it, in front: Chromium's own copy (history and all) where the helper can make one.
const duplicate = async (record: BrowserSessionRecord, entry: PageRecord): Promise<OpenBrowserResult> => {
    const helper = record.helper;
    const targetId = entry.deferred === undefined ? await pageTargetId(entry) : undefined;
    const copy = helper === undefined || targetId === undefined ? undefined : await tabOpenedBy(record, () => helper.duplicate(targetId));
    const id = copy?.id ?? (await freshTab(record.name, shownUrl(entry)));
    if (id === undefined) {
        return { name: record.name };
    }
    return placeInFront(record, id, indexAmong(record.pages, entry.id, isOpen) + 1);
};

const mute = async (record: BrowserSessionRecord, entry: PageRecord, muted: boolean): Promise<void> => {
    const targetId = await pageTargetId(entry);
    if (record.helper === undefined || targetId === undefined || !(await record.helper.mute(targetId, muted))) {
        return;
    }
    // Said at once rather than when the helper next reports, which it will, the same.
    record.sound = new Map(record.sound).set(targetId, { audible: record.sound?.get(targetId)?.audible ?? false, muted });
    windowChanged(record);
};

// One thing done to one tab, whether or not it is in front; answers the tab acted on, or the copy.
export const tabAction = async (name: string, pageId: string, action: BrowserPageAction): Promise<OpenBrowserResult> => {
    const record = openWindow(name);
    const entry = record?.pages.get(pageId);
    if (record === undefined || entry === undefined || entry.closed) {
        return { name };
    }
    switch (action) {
        case "reload":
            if (entry.deferred === undefined) {
                // allow(silent-catch): a reload that fails shows Chromium's own error page in the tab.
                void entry.page.reload({ waitUntil: "commit" }).catch(() => undefined);
            } else {
                wakeDeferred(entry);
            }
            return { name, pageId };
        case "duplicate":
            return duplicate(record, entry);
        case "mute":
        case "unmute":
            await mute(record, entry, action === "mute");
            return { name, pageId };
    }
};

// Takes each tab's sound as the helper hears it, until the window ends. The report is kept whole and a tab is given its
// own as the window is listed, by the target id its session reads as it opens: the helper reports a new tab as Chromium
// creates it, often before that tab's session has opened, and says nothing more until a tab's sound changes or a tab
// opens or closes, so a report applied only to the tabs whose id was known by then left the newest without sound for
// good (a restore's last tab, 2026-11-20).
const followSound = (record: BrowserSessionRecord, helper: TabHelper): void => {
    const stop = helper.watchSound((sound) => {
        if (record.finishedAt !== undefined) {
            stop();
            return;
        }
        record.sound = sound;
        windowChanged(record);
    });
};

// The window's helper, once its worker is up: from then on its tabs say whether they play sound, and a reopen or a copy
// goes through Chromium's own tab model. A window whose helper never comes keeps working without it.
export const attachTabHelper = (name: string, helper: TabHelper | undefined): void => {
    const record = openWindow(name);
    if (record === undefined || helper === undefined) {
        return;
    }
    record.helper = helper;
    followSound(record, helper);
};

// Reopens a window's kept tabs in their order (own-tabs.ts), in the tab a fresh window opened on and as many more as it
// needs: the one that was in front loads and goes in front, the rest stand as where they were and load when first
// picked. Answers the tab in front, undefined when the window could not take them.
export const restoreTabs = async (name: string, saved: OwnTabs): Promise<string | undefined> => {
    const record = openWindow(name);
    const first = browserSessionBlankPage(name);
    if (record === undefined || first === undefined) {
        return undefined;
    }
    const ids = [first.id];
    while (ids.length < saved.tabs.length) {
        const tab = await browserSessionNewTab(name);
        if (tab?.id === undefined) {
            break;
        }
        ids.push(tab.id);
    }
    for (const [index, id] of ids.entries()) {
        const entry = record.pages.get(id);
        const tab = saved.tabs[index];
        if (entry !== undefined && tab !== undefined) {
            entry.deferred = { url: tab.url, title: tab.title, favicon: tab.favicon };
        }
    }
    // Picking it loads it (deferred-tabs.ts) and tells Chromium which tab is in front, which the picture follows.
    const front = ids[Math.min(saved.front, ids.length - 1)] ?? first.id;
    await pickBrowserPage(name, front);
    windowChanged(record, true);
    return front;
};
