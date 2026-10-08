import { sandboxRef } from "@intentic/extension-api";
import { computed } from "vue";
import type { Router } from "vue-router";
import { storedValue, storeValue } from "../../lib/browserStorage";
import { guestAllowedPath } from "../../lib/routes/guestPaths";
import { openBeside, sideDocked } from "../side/sideTabs";
import { handOffToMainWindow } from "../window/mainWindow";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { useRole } from "../../client/sandbox/useRole";
import { browsersPath, parseTabKey, sameTab, tabKey, WEB_FRONT, type LiveTab, type PinnedTab } from "./browsersPaths";

// THE BROWSERS VIEW'S OWN STATE: which tabs its strip holds besides the web pages of the window in front, which tab is in
// front, and whether the view exists at all. Module-level, like the chat's and the terminal's, since the view is one
// panel per window that mounts above the router and moves between /browsers, the side panel and a window of its own
// (PoppablePanels.vue). Nothing mounts until someone first looks, and once opened it stays mounted, parked, so a
// previewed app keeps its state between looks.
//
// Tabs and their keys are browsersPaths.ts's.

// --- Persistence ----------------------------------------------------------------------------------------------------
// The pins and the tab in front, per sandbox, so a reload opens on the same strip. The live app the old Preview view
// showed last becomes the first pin, once, so nobody loses the app they were looking at to the move.

const tabsKey = (sandboxId: string | undefined): string => `intentic-browsers-tabs:${sandboxId ?? ``}`;
const legacyPreviewKey = (sandboxId: string | undefined): string => `intentic-preview-target:${sandboxId ?? ``}`;

interface StoredTabs {
    readonly pinned: readonly PinnedTab[];
    readonly front: LiveTab;
}

const restore = (): StoredTabs => {
    const sandboxId = useSandbox().activeSandboxId.value;
    const raw = storedValue(tabsKey(sandboxId));
    if (raw !== undefined) {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed === `object` && parsed !== null && `pinned` in parsed && Array.isArray(parsed.pinned)) {
                const pinned = parsed.pinned
                    .filter((key): key is string => typeof key === `string`)
                    .map(parseTabKey)
                    .filter((tab): tab is PinnedTab => tab.kind !== `web`);
                const front = `front` in parsed && typeof parsed.front === `string` ? parseTabKey(parsed.front) : WEB_FRONT;
                return { pinned, front };
            }
        } catch {
            // allow(silent-catch): a stored strip that is not JSON is no strip; the view opens on its start page.
        }
    }
    const legacy = storedValue(legacyPreviewKey(sandboxId));
    if (legacy !== undefined && legacy !== `` && legacy !== `address`) {
        const tab: PinnedTab = { kind: `preview`, id: legacy };
        return { pinned: [tab], front: tab };
    }
    return { pinned: [], front: WEB_FRONT };
};

const persist = (): void => {
    storeValue(tabsKey(useSandbox().activeSandboxId.value), JSON.stringify({ pinned: pinned.value.map(tabKey), front: tabKey(front.value) }));
};

// --- State ----------------------------------------------------------------------------------------------------------

// A switch closes the parked view rather than keep the outgoing sandbox's apps loaded, and brings back the incoming
// one's own strip.
const opened = sandboxRef(() => false);
const restored = sandboxRef<StoredTabs>(restore);
const pinned = computed<readonly PinnedTab[]>({
    get: () => restored.value.pinned,
    set: (next) => {
        restored.value = { ...restored.value, pinned: next };
        persist();
    },
});
const front = computed<LiveTab>({
    get: () => restored.value.front,
    set: (next) => {
        restored.value = { ...restored.value, front: next };
        persist();
    },
});
// Asked for "the live app" without naming one (the palette, the status bar's chip): the view picks the app most worth
// seeing once it knows which apps there are, since only it reads that list.
const wantsPreview = sandboxRef(() => false);

export const browsersOpened = opened;
export const browsersPinned = pinned;
export const browsersFront = front;
export const browsersWantPreview = wantsPreview;

export const markBrowsersOpened = (): void => {
    opened.value = true;
};

// Puts a tab in front, pinning it first when it is one of the reader's own kinds and not on the strip yet.
export const showTab = (tab: LiveTab): void => {
    if (tab.kind !== `web` && !pinned.value.some((held) => sameTab(held, tab))) {
        pinned.value = [...pinned.value, tab];
    }
    if (!sameTab(front.value, tab)) {
        front.value = tab;
    }
};

// Takes a pin off the strip. The one in front hands the front to its neighbour (the one after it, else the one before),
// or back to the web windows when it was the last.
export const unpinTab = (tab: PinnedTab): void => {
    const at = pinned.value.findIndex((held) => sameTab(held, tab));
    if (at < 0) {
        return;
    }
    const rest = pinned.value.filter((_, index) => index !== at);
    if (sameTab(front.value, tab)) {
        front.value = rest[at] ?? rest[at - 1] ?? WEB_FRONT;
    }
    pinned.value = rest;
};

export const requestDefaultPreview = (): void => {
    wantsPreview.value = true;
};

// --- Ways in --------------------------------------------------------------------------------------------------------

// The side panel's name for the view: one tab, since a window draws one Browsers view.
export const BROWSERS_SIDE_VIEW = `browsers`;

// Opens the view on a tab (or where it was) and goes to its route.
export const openBrowsers = (router: Router, tab?: LiveTab): void => {
    if (tab !== undefined) {
        showTab(tab);
    }
    markBrowsersOpened();
    void router.push(browsersPath(front.value));
};

// The live app on a target, or the one most worth seeing.
export const openPreview = (router: Router, targetId?: string): void => {
    if (targetId === undefined) {
        requestDefaultPreview();
        openBrowsers(router);
        return;
    }
    openBrowsers(router, { kind: `preview`, id: targetId });
};

// A tab shown beside the section the reader is in rather than taking the main area: a running app a turn left
// for them, a localhost link. Standing on /browsers it simply comes to front there; a window with no side panel, or a
// reader the view is closed to, goes to /browsers; a popped-out panel hands it to the app's own window. Kept, not a
// peek: replacing it with the next file looked at would reload the app.
export const openBrowsersBeside = (router: Router, tab?: LiveTab): void => {
    const beside = sideDocked.value && router.currentRoute.value.name !== `browsers` && (!useRole().isGuest.value || guestAllowedPath(`/browsers`));
    if (!beside) {
        if (!handOffToMainWindow({ kind: `browsers`, tab: tab === undefined ? undefined : tabKey(tab) })) {
            openBrowsers(router, tab);
        }
        return;
    }
    if (tab !== undefined) {
        showTab(tab);
    }
    markBrowsersOpened();
    openBeside(BROWSERS_SIDE_VIEW, {}, { keep: true });
};

export const openPreviewBeside = (router: Router, targetId?: string): void => {
    if (targetId === undefined) {
        requestDefaultPreview();
    }
    openBrowsersBeside(router, targetId === undefined ? undefined : { kind: `preview`, id: targetId });
};

// Opens the live app once per sandbox, on first visit only; the reader's later choice (open or closed) always wins
// after that. Stored, not in-memory, so the flag survives a reload; answers whether it opened.
const autoShownKey = (sandboxId: string | undefined): string => `intentic-preview-autoshown:${sandboxId ?? ``}`;

export const openPreviewOnFirstVisit = (router: Router, targetId: string): boolean => {
    const key = autoShownKey(useSandbox().activeSandboxId.value);
    if (storedValue(key) !== undefined) {
        return false;
    }
    storeValue(key, `1`);
    openPreviewBeside(router, targetId);
    return true;
};
