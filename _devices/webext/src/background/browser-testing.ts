import { collectPage } from "../page/driver.js";
import { askConfirm, dismissConfirm, flashBanner } from "../page/overlay.js";

// A browser of windows and tabs for the tests of the agent's own window (agent-window.test.ts, asking.test.ts): enough
// of Chrome's windows, tabs, scripting and storage to say which window got focus, which tab was pointed where, and what
// was asked on which page. Written by hand, so a tool that reaches for a Chrome API this file does not admit fails its
// test until it does. Behaves as Brave 156 on Windows was measured to (2026-10-28): a window created unfocused stays
// unfocused, and a minimized window's capture never comes.

export interface FakeWindow {
    id: number;
    focused: boolean;
    state: "normal" | "minimized" | "maximized";
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface FakeTab {
    id: number;
    windowId: number;
    active: boolean;
    url: string;
    title: string;
}

// A call that could change what the person sees, in order: a window opened, focused, flashed or minimized, a tab
// pointed somewhere or brought to the front, a capture, the badge, the popup.
export type Call = readonly [api: string, ...args: readonly (string | number | object | undefined)[]];

// The functions the tests tell apart in a page, by what they do there.
export type PageWork = "ask" | "dismiss" | "snapshot" | "banner" | "other";
const WORK = new Map<object, PageWork>([
    [askConfirm, "ask"],
    [dismissConfirm, "dismiss"],
    [collectPage, "snapshot"],
    [flashBanner, "banner"],
]);

// A function run in a page, with what it was given.
export interface Injection {
    readonly tabId: number;
    readonly work: PageWork;
    readonly args: readonly unknown[];
}

export interface FakeBrowser {
    readonly windows: FakeWindow[];
    readonly tabs: FakeTab[];
    readonly calls: Call[];
    readonly injections: Injection[];
    readonly session: Map<string, unknown>;
    // What the page's Allow/No panel answers; "wait" leaves it asking until it is dismissed.
    pageAnswer: boolean | "wait";
    // Chrome refusing bounds less than half on a screen, as it does for a monitor that was unplugged.
    refuseBounds: boolean;
    // A capture that never comes, whatever the window's state.
    captureHangs: boolean;
}

// The person's own window, in front of them, on their inbox.
export const PERSON_WINDOW = 1;
export const PERSON_TAB = 10;
const PNG = "data:image/png;base64,iVBORw0KGgo=";

type Stored = Parameters<chrome.storage.Area["set"]>[0];

const area = (storage: Map<string, unknown>) => ({
    get: async (keys: string[] | null) =>
        Object.fromEntries((keys ?? [...storage.keys()]).filter((key) => storage.has(key)).map((key) => [key, storage.get(key)])),
    set: async (items: Stored) => {
        for (const [key, value] of Object.entries(items)) {
            storage.set(key, value);
        }
    },
    remove: async (keys: string[]) => {
        for (const key of keys) {
            storage.delete(key);
        }
    },
});

interface World {
    readonly browser: FakeBrowser;
    readonly loaded: Set<(tabId: number, change: { status?: string }) => void>;
    nextWindow: number;
    nextTab: number;
}

const windowOf = (world: World, id: number): FakeWindow => {
    const found = world.browser.windows.find((window) => window.id === id);
    if (found === undefined) {
        throw new Error(`No window with id: ${id}.`);
    }
    return found;
};

const tabOf = (world: World, id: number): FakeTab => {
    const found = world.browser.tabs.find((tab) => tab.id === id);
    if (found === undefined) {
        throw new Error(`No tab with id: ${id}.`);
    }
    return found;
};

const activate = (world: World, tab: FakeTab): void => {
    for (const other of world.browser.tabs.filter((each) => each.windowId === tab.windowId)) {
        other.active = other === tab;
    }
};

const focus = (world: World, window: FakeWindow): void => {
    for (const other of world.browser.windows) {
        other.focused = other === window;
    }
};

// A navigation completes once whoever asked for it is listening, as a real one does some time later.
const complete = (world: World, tabId: number): void => {
    setTimeout(() => {
        for (const listener of world.loaded) {
            listener(tabId, { status: "complete" });
        }
    }, 1);
};

const populated = (world: World, window: FakeWindow) => ({
    ...window,
    tabs: world.browser.tabs.filter((tab) => tab.windowId === window.id).map((tab) => ({ ...tab })),
});

const windowsApi = (world: World) => ({
    create: async (data: { url?: string; focused?: boolean; left?: number; top?: number; width?: number; height?: number }) => {
        world.browser.calls.push(["windows.create", data]);
        if (world.browser.refuseBounds && data.left !== undefined) {
            throw new Error(`Invalid value for bounds. Bounds must be at least 50% within visible screen space.`);
        }
        // Given no bounds, Brave takes those of the window last used.
        const like = windowOf(world, PERSON_WINDOW);
        const window: FakeWindow = {
            id: world.nextWindow++,
            focused: false,
            state: "normal",
            left: data.left ?? like.left,
            top: data.top ?? like.top,
            width: data.width ?? like.width,
            height: data.height ?? like.height,
        };
        world.browser.windows.push(window);
        if (data.focused !== false) {
            focus(world, window);
        }
        const tab: FakeTab = { id: world.nextTab++, windowId: window.id, active: true, url: data.url ?? "about:blank", title: "New tab" };
        world.browser.tabs.push(tab);
        complete(world, tab.id);
        return populated(world, window);
    },
    get: async (id: number, options?: { populate?: boolean }) =>
        options?.populate === true ? populated(world, windowOf(world, id)) : { ...windowOf(world, id) },
    update: async (id: number, info: { focused?: boolean; drawAttention?: boolean; state?: FakeWindow["state"] }) => {
        world.browser.calls.push(["windows.update", id, info]);
        const window = windowOf(world, id);
        if (info.state !== undefined) {
            window.state = info.state;
        }
        if (info.focused === true) {
            focus(world, window);
        }
        return { ...window };
    },
});

const tabsApi = (world: World) => ({
    query: async (query: { active?: boolean; currentWindow?: boolean }) =>
        world.browser.tabs
            .filter((tab) => query.active !== true || query.currentWindow !== true || (tab.active && windowOf(world, tab.windowId).focused))
            .map((tab) => ({ ...tab })),
    get: async (id: number) => ({ ...tabOf(world, id) }),
    update: async (id: number, properties: { url?: string; active?: boolean }) => {
        world.browser.calls.push(["tabs.update", id, properties]);
        const tab = tabOf(world, id);
        if (properties.url !== undefined) {
            tab.url = properties.url;
            complete(world, id);
        }
        if (properties.active === true) {
            activate(world, tab);
        }
        return { ...tab };
    },
    create: async (properties: { url?: string; active?: boolean; windowId?: number }) => {
        world.browser.calls.push(["tabs.create", properties]);
        const windowId = properties.windowId ?? world.browser.windows.find((window) => window.focused)?.id ?? PERSON_WINDOW;
        const tab: FakeTab = { id: world.nextTab++, windowId, active: false, url: properties.url ?? "about:blank", title: "New tab" };
        world.browser.tabs.push(tab);
        if (properties.active !== false) {
            activate(world, tab);
        }
        complete(world, tab.id);
        return { ...tab };
    },
    captureVisibleTab: async (windowId: number) => {
        const { state } = windowOf(world, windowId);
        world.browser.calls.push(["tabs.captureVisibleTab", windowId, state]);
        return world.browser.captureHangs || state === "minimized" ? await new Promise<string>(() => undefined) : PNG;
    },
    onUpdated: {
        addListener: (listener: (tabId: number, change: { status?: string }) => void) => world.loaded.add(listener),
        removeListener: (listener: (tabId: number, change: { status?: string }) => void) => world.loaded.delete(listener),
    },
});

// The page answers each injected function as the real one would: the Allow/No panel as `pageAnswer` says, a snapshot
// of an empty page for anything that reads it.
const scriptingApi = (world: World) => ({
    executeScript: async (injection: { target: { tabId: number }; func: object; args?: unknown[] }) => {
        const work = WORK.get(injection.func) ?? "other";
        world.browser.injections.push({ tabId: injection.target.tabId, work, args: injection.args ?? [] });
        if (work === "ask") {
            return world.browser.pageAnswer === "wait" ? await new Promise(() => undefined) : [{ frameId: 0, result: world.browser.pageAnswer }];
        }
        if (work === "dismiss" || work === "banner") {
            return [{ frameId: 0, result: true }];
        }
        const url = tabOf(world, injection.target.tabId).url;
        return [{ frameId: 0, result: { url, title: "Page", truncated: false, loading: false, elements: [] } }];
    },
});

export const installBrowser = (): FakeBrowser => {
    const browser: FakeBrowser = {
        windows: [{ id: PERSON_WINDOW, focused: true, state: "maximized", left: 0, top: 0, width: 1700, height: 950 }],
        tabs: [{ id: PERSON_TAB, windowId: PERSON_WINDOW, active: true, url: "https://mail.example/inbox", title: "Inbox" }],
        calls: [],
        injections: [],
        session: new Map(),
        pageAnswer: true,
        refuseBounds: false,
        captureHangs: false,
    };
    const world: World = { browser, loaded: new Set(), nextWindow: 2, nextTab: 20 };
    const fake = {
        storage: { local: area(new Map()), session: area(browser.session) },
        windows: windowsApi(world),
        tabs: tabsApi(world),
        permissions: { contains: async () => true, getAll: async () => ({ origins: [] }) },
        scripting: scriptingApi(world),
        action: {
            setBadgeText: async (details: { text: string }) => {
                browser.calls.push(["badge", details.text]);
            },
            setBadgeBackgroundColor: async () => undefined,
            setTitle: async () => undefined,
            openPopup: async () => {
                browser.calls.push(["popup"]);
            },
        },
        runtime: { getManifest: () => ({ version: "0.1.0", name: "Intentic" }) },
    };
    // A capture as small as it comes, so fit-capture.ts hands it back as it is rather than drawing it again.
    Object.assign(globalThis, { chrome: fake, createImageBitmap: async () => ({ width: 8, height: 8, close: () => undefined }) });
    return browser;
};

// What the person would have seen move: windows opened, focused or minimized, tabs pointed somewhere or brought front.
export const moves = (browser: FakeBrowser): Call[] =>
    browser.calls.filter(([api]) => api === "tabs.update" || api === "tabs.create" || api === "windows.create" || api === "windows.update");

export const injectedInto = (browser: FakeBrowser, work: PageWork): Injection[] => browser.injections.filter((injection) => injection.work === work);
