import { untilTabLoaded } from "./tab-loaded.js";

/* `open` reads the page back once the tab says it has loaded, rather than after a fixed 600 ms that on a slow site read
   the page before it arrived (2026-10-20). Chrome's tab events are driven by hand. */

type Listener = (tabId: number, change: { status?: string }) => void;

const fakeChrome = () => {
    const listeners = new Set<Listener>();
    Object.assign(globalThis, {
        chrome: { tabs: { onUpdated: { addListener: (listener: Listener) => listeners.add(listener), removeListener: (listener: Listener) => listeners.delete(listener) } } },
    });
    return { listeners, update: (tabId: number, change: { status?: string }) => [...listeners].forEach((listener) => listener(tabId, change)) };
};

test("the wait ends on that tab's complete, not another tab's, nor its loading", async () => {
    const chrome = fakeChrome();
    let loaded: boolean | undefined;
    const waiting = untilTabLoaded(7, 5_000).then((value) => {
        loaded = value;
    });
    chrome.update(7, { status: "loading" });
    chrome.update(8, { status: "complete" });
    await Promise.resolve();
    expect(loaded).toBeUndefined();
    chrome.update(7, { status: "complete" });
    await waiting;
    expect(loaded).toBe(true);
    // Its listener is gone with it.
    expect(chrome.listeners.size).toBe(0);
});

test("a page that never completes is read as it stands at the cap", async () => {
    const chrome = fakeChrome();
    expect(await untilTabLoaded(7, 30)).toBe(false);
    expect(chrome.listeners.size).toBe(0);
});
