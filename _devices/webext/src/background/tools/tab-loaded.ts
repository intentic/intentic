// Waits for a tab the agent just pointed somewhere to finish loading, before the page is read back (2026-10-20). It
// used to be a fixed 600 ms, which on a slow site read the page before it had arrived (or the one it was leaving). The
// wait ends on Chrome's own signal, the tab's `status: "complete"`, and the cap is only for a page that never gets
// there (a long poll, a stalled image): the page is read as it stands then. webNavigation's DOMContentLoaded would end
// sooner on a heavy page, but needs a permission this extension does not ask for.
const OPEN_LOAD_CAP_MS = 10_000;

// Whether the tab reported complete within the cap. Listening starts as soon as the navigation was asked for; its
// complete comes after the tab has committed the new page, so it cannot have fired before this listens.
export const untilTabLoaded = async (tabId: number, capMs: number = OPEN_LOAD_CAP_MS): Promise<boolean> =>
    await new Promise((resolve) => {
        const finish = (loaded: boolean): void => {
            clearTimeout(cap);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve(loaded);
        };
        const onUpdated = (id: number, change: { status?: string }): void => {
            if (id === tabId && change.status === "complete") {
                finish(true);
            }
        };
        const cap = setTimeout(() => finish(false), capMs);
        chrome.tabs.onUpdated.addListener(onUpdated);
    });

// Whether a tab that may or may not be navigating has settled, for reading it back after an action. Unlike
// untilTabLoaded, which follows a navigation the caller just asked for, an action may have started one or not: a tab
// that is not loading has nothing to wait for, so this answers at once. It listens before it looks, so a complete
// that comes between the look and the listening is not missed.
export const untilTabSettled = async (tabId: number, capMs: number = OPEN_LOAD_CAP_MS): Promise<boolean> => {
    let finish: (loaded: boolean) => void = () => undefined;
    const settled = new Promise<boolean>((resolve) => {
        const onUpdated = (id: number, change: { status?: string }): void => {
            if (id === tabId && change.status === "complete") {
                finish(true);
            }
        };
        const cap = setTimeout(() => finish(false), capMs);
        finish = (loaded: boolean): void => {
            clearTimeout(cap);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve(loaded);
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
    });
    // allow(silent-catch): a tab that closed has nothing left to load, which is settled
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab?.status !== "loading") {
        finish(true);
    }
    return await settled;
};
