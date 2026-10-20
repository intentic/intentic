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
