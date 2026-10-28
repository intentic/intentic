import { type SandboxKey, store, type WindowBounds } from "./store.js";

// The agent's own window (2026-10-28). Until then the agent worked in whatever tab was in front of the person: `open`
// pointed that very tab somewhere else, and every tool given no tab acted on the page they were reading, so their own
// work was taken over mid-sentence. It now works in a window of its own, opened unfocused. Measured on Brave 156 on
// Windows: such a window opens behind theirs, their page keeps focus, and given no bounds it takes the bounds of the
// window they last used, so it sits exactly behind it. Covered like that its pages are throttled (no animation frames,
// timers about once a second) while clicks, typing and navigation all work, and captureVisibleTab still reads it.
// Dragged to a spare monitor it renders in full, and where they put it is where the next one opens.
//
// Never created minimized: Brave ignores `state: "minimized"` on create and opens a normal, FOCUSED window on top of
// theirs, the very thing this window is for avoiding. Minimizing it is the person's to do; screenshots cope (page.ts).
//
// One window per paired sandbox: two agents sharing one would each point the other's tab somewhere else. Where the
// person last put any of them is where the next one opens.

// Whether the agent works in its own window rather than in their tab: the person's choice in the popup.
export const ownWindow = async (): Promise<boolean> => (await store.settings()).workIn === "own-window";

// A sandbox's agent window while it is still open, with its tabs. An id kept for a window that has since closed is
// forgotten here, so the next `open` makes a new one.
export const agentWindow = async (from: SandboxKey): Promise<chrome.windows.Window | undefined> => {
    const id = await store.agentWindowId(from);
    if (id === undefined) {
        return undefined;
    }
    // allow(silent-catch): Chrome rejects `get` for a window that no longer exists, which is the answer asked for
    const found = await chrome.windows.get(id, { populate: true }).catch(() => undefined);
    if (found === undefined) {
        await store.setAgentWindowId(from, undefined);
    }
    return found;
};

// Whether `windowId` is the window of `from`'s agent, or with no sandbox named, of any sandbox's.
export const isAgentWindow = async (windowId: number | undefined, from?: SandboxKey): Promise<boolean> => {
    if (windowId === undefined) {
        return false;
    }
    return from === undefined ? Object.values(await store.agentWindows()).includes(windowId) : windowId === (await store.agentWindowId(from));
};

// The sandbox whose agent window `windowId` is, if it is one.
export const agentWindowOwner = async (windowId: number | undefined): Promise<SandboxKey | undefined> =>
    Object.entries(await store.agentWindows()).find(([, id]) => id === windowId)?.[0];

// The tab in front in a sandbox's agent window: what its tools given no tab work on.
export const agentTab = async (from: SandboxKey): Promise<chrome.tabs.Tab | undefined> =>
    (await agentWindow(from))?.tabs?.find((tab) => tab.active === true);

// Opens the agent's window on `url`, unfocused, where the person last put it. Bounds remembered on a monitor that is
// no longer plugged in are refused by Chrome (less than half on a screen), so they are dropped and the window opens
// where Chrome puts it.
const openWindow = async (from: SandboxKey, url: string): Promise<chrome.tabs.Tab | undefined> => {
    const bounds = await store.agentWindowBounds();
    const create = async (at: WindowBounds | undefined): Promise<chrome.windows.Window> =>
        await chrome.windows.create({ url, focused: false, ...at });
    let opened: chrome.windows.Window;
    try {
        opened = await create(bounds);
    } catch (error) {
        if (bounds === undefined) {
            throw error;
        }
        await store.setAgentWindowBounds(undefined);
        opened = await create(undefined);
    }
    if (opened.id !== undefined) {
        await store.setAgentWindowId(from, opened.id);
    }
    return opened.tabs?.[0];
};

export interface Opened {
    readonly tab: chrome.tabs.Tab | undefined;
    // The window did not exist before this call, which the agent is told once.
    readonly created: boolean;
}

// Points the agent at `url`: the tab in front of its window, a new tab beside it (`fresh`), or a new window when it has
// none. The person's windows are never touched, and a tab made active here is active only in the agent's window.
export const openInAgentWindow = async (from: SandboxKey, url: string, fresh: boolean): Promise<Opened> => {
    const window = await agentWindow(from);
    if (window?.id === undefined) {
        return { tab: await openWindow(from, url), created: true };
    }
    const front = window.tabs?.find((tab) => tab.active === true);
    const tab =
        fresh || front?.id === undefined
            ? await chrome.tabs.create({ windowId: window.id, url, active: true })
            : await chrome.tabs.update(front.id, { url });
    return { tab, created: false };
};

// Kept from the window's own bounds events: wherever the person drags or sizes it, including maximized on a spare
// monitor, which a normal window of the same bounds then fills. A minimized or fullscreen window says nothing about
// where to open the next one.
export const rememberBounds = async (window: chrome.windows.Window): Promise<void> => {
    const { left, top, width, height } = window;
    if (!(await isAgentWindow(window.id)) || window.state === "minimized" || window.state === "fullscreen") {
        return;
    }
    if (left === undefined || top === undefined || width === undefined || height === undefined) {
        return;
    }
    await store.setAgentWindowBounds({ left, top, width, height });
};

export const forgetClosedWindow = async (windowId: number): Promise<void> => {
    const owner = await agentWindowOwner(windowId);
    if (owner !== undefined) {
        await store.setAgentWindowId(owner, undefined);
    }
};

// Brings a tab (a sandbox's agent's front tab, when a sandbox is named instead) and its window in front of the person.
// Only ever for their own click in the popup, or for a step only they can take on that page: never as part of the
// agent's work.
export const showTab = async (target: { readonly tabId: number } | { readonly sandbox: SandboxKey }): Promise<boolean> => {
    // allow(silent-catch): a tab that closed meanwhile has nothing to show, which is what false says
    const tab = "tabId" in target ? await chrome.tabs.get(target.tabId).catch(() => undefined) : await agentTab(target.sandbox);
    if (tab?.id === undefined || tab.windowId === undefined) {
        return false;
    }
    await chrome.tabs.update(tab.id, { active: true });
    const window = await chrome.windows.get(tab.windowId);
    // Focusing a minimized window leaves it minimized on some builds; restoring it is part of showing it.
    if (window.state === "minimized") {
        await chrome.windows.update(tab.windowId, { state: "normal", focused: true });
    } else {
        await chrome.windows.update(tab.windowId, { focused: true });
    }
    return true;
};
