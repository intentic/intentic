import { computed, type ComputedRef, shallowReactive } from "vue";

/* IS ANYONE LOOKING — the question `document.visibilityState` stopped answering the day a panel could float in
 * a window of its own. Everything a popped-out panel shows is rendered by the realm in the app's TAB (see
 * usePopout), so `document` here is always that tab's, and a gate reading it learns nothing about the window
 * the user is actually reading. Both gates in the app were wrong the same way: a chat read in a pop-out while
 * the tab sat behind another one kept its "Updated" badge, and the person typing in it was reported idle to
 * everyone else — until they clicked back to the tab, at which point both caught up at once and the pop-out
 * read as the window whose actions go nowhere.
 *
 * So the fact is kept per DOCUMENT — the app's own, plus every pop-out document adopted right now — and the app
 * is on screen while ANY of them is. `visibilitychange` describes the document it is armed on, which is exactly
 * this, so each document answers for itself and nothing has to be forwarded between windows.
 *
 * A window buried under another window still calls itself visible: the browser says hidden for a minimized
 * window or a background tab, not for an occluded one. That is the same approximation the single-window gate
 * always made, and the one these gates want — a window the user has on screen is one they can be reading. */

// Every document the app renders into, and whether it is on screen right now. Empty only in the node test env,
// where there is no document to register — and no window that could be hiding anything.
const screens = shallowReactive(new Map<Document, boolean>());
const syncs = new Map<Document, () => void>();

export const onScreen: ComputedRef<boolean> = computed(() => [...screens.values()].some(Boolean));

// A document joins as the app starts rendering into it: this page's own at load, a pop-out's the moment its
// window is adopted.
export const watchOnScreen = (doc: Document): void => {
    const sync = (): void => {
        screens.set(doc, doc.visibilityState === `visible`);
    };
    syncs.set(doc, sync);
    doc.addEventListener(`visibilitychange`, sync);
    sync();
};

// …and leaves when the panel docks — a window no longer showing the app cannot answer for it. The document
// itself may well outlive this (a reload out there hands the same window back), so the listener goes too.
export const unwatchOnScreen = (doc: Document): void => {
    const sync = syncs.get(doc);
    if (sync === undefined) {
        return;
    }
    doc.removeEventListener(`visibilitychange`, sync);
    syncs.delete(doc);
    screens.delete(doc);
};

if (typeof document !== `undefined`) {
    watchOnScreen(document);
}
