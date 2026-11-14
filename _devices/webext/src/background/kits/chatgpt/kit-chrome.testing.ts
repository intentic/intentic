import { object, string } from "zod";
import { store } from "../../store.js";
import { type FakeAccount, type FakeChatgpt, type FakeOptions, giveEveryElementABox, mountFakeChatgpt } from "./fake-chatgpt.testing.js";

// The browser the ChatGPT kit's worker suites run in: a hand-written Chrome whose executeScript runs each injected
// function against jsdom's document, where the stand-in ChatGPT page answers (fake-chatgpt.testing.ts). Tabs, windows,
// storage and the person's answers are all here; what a suite changes between tests is on `kitBrowser`.

export const SANDBOX = "https://sandbox-1.example.dev";

interface FakeTab {
    id: number;
    windowId: number;
    active: boolean;
    url: string;
}

export interface KitBrowser {
    tabs: FakeTab[];
    created: string[];
    injected: string[];
    // The send step's answer is lost, as when ChatGPT's route change replaced the document under it.
    loseSendAnswer: boolean;
    // How many watch rounds in a row the page fails to answer at once, as a page mid-reload does.
    lostWatches: number;
    // How the next ChatGPT page loaded behaves.
    page: FakeOptions;
    // The page loaded last.
    fake: FakeChatgpt | undefined;
    // The signed-in account's projects, kept across pages.
    account: FakeAccount;
    // What the person answers when asked on the page, and every question they were asked.
    allow: boolean;
    asked: string[];
    // The sandbox files a ticket collects (file-tickets.ts on the other side), by ticket.
    shelf: Map<string, { name: string; type: string; text: string }>;
}

export const kitBrowser: KitBrowser = {
    tabs: [],
    created: [],
    injected: [],
    loseSendAnswer: false,
    lostWatches: 0,
    page: {},
    fake: undefined,
    account: { projects: [] },
    allow: true,
    asked: [],
    shelf: new Map(),
};

const loaded: ((id: number, change: { status?: string }) => void)[] = [];

// What chrome.storage keeps: JSON values.
type Stored = string | number | boolean | object | null;

const area = (storage: Map<string, Stored>): chrome.storage.Area => ({
    get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => storage.has(key)).map((key) => [key, storage.get(key)])),
    set: async (items) => {
        for (const [key, value] of Object.entries(items)) {
            // SAFETY: what reaches chrome.storage is JSON-serializable by its own contract, which Stored spells out.
            storage.set(key, value as Stored);
        }
    },
    remove: async (keys: string[]) => {
        for (const key of keys) {
            storage.delete(key);
        }
    },
});

// A tab pointed at chatgpt.com gets the stand-in page, of the kind its address names; its address moves when the page
// routes (a chat's first message) or navigates (a project just made). A chat's own address (/c/…) keeps the page as it
// was, as ChatGPT's client-side route does.
const load = (tab: FakeTab): void => {
    const url = new URL(tab.url);
    if (url.host === "chatgpt.com" && !url.pathname.includes("/c/")) {
        const projectId = /^\/g\/g-p-([A-Za-z0-9]+)/.exec(url.pathname)?.[1];
        const project = kitBrowser.account.projects.find((each) => each.id === projectId);
        const kind = url.searchParams.get("temporary-chat") === "true" ? "temporary" : project !== undefined ? "project" : "home";
        kitBrowser.fake = mountFakeChatgpt({
            ...kitBrowser.page,
            page: kind,
            account: kitBrowser.account,
            project,
            onRoute: (path) => {
                tab.url = `https://chatgpt.com${path}`;
            },
            onNavigate: (path) => {
                tab.url = `https://chatgpt.com${path}`;
                load(tab);
            },
        });
    }
    setTimeout(() => {
        for (const listener of loaded) {
            listener(tab.id, { status: "complete" });
        }
    }, 0);
};

// What an injected function hands back: a step's answer, an installer's true, or nothing.
type Answer = object | boolean | null;

const windowOf = (id: number) => ({ id, focused: false, state: "normal", tabs: kitBrowser.tabs.filter((tab) => tab.windowId === id).map((tab) => ({ ...tab })) });

const tabsApi = {
    query: async () => kitBrowser.tabs.filter((tab) => tab.active).map((tab) => ({ ...tab })),
    get: async (id: number) => {
        const tab = kitBrowser.tabs.find((each) => each.id === id);
        return tab === undefined ? Promise.reject(new Error(`No tab with id: ${id}`)) : { ...tab };
    },
    create: async (properties: { url: string; active?: boolean; windowId?: number }) => {
        kitBrowser.created.push(properties.url);
        const windowId = properties.windowId ?? 1;
        if (properties.active === true) {
            for (const tab of kitBrowser.tabs.filter((each) => each.windowId === windowId)) {
                tab.active = false;
            }
        }
        const tab = { id: 100 + kitBrowser.tabs.length, windowId, active: properties.active === true, url: properties.url };
        kitBrowser.tabs.push(tab);
        load(tab);
        return { ...tab };
    },
    update: async (id: number, properties: { url?: string; active?: boolean }) => {
        const tab = kitBrowser.tabs.find((each) => each.id === id);
        if (tab === undefined) {
            throw new Error(`No tab with id: ${id}`);
        }
        if (properties.active === true) {
            for (const other of kitBrowser.tabs.filter((each) => each.windowId === tab.windowId)) {
                other.active = other === tab;
            }
        }
        if (properties.url !== undefined) {
            tab.url = properties.url;
            load(tab);
        }
        return { ...tab };
    },
    remove: async (id: number) => {
        kitBrowser.tabs = kitBrowser.tabs.filter((tab) => tab.id !== id);
    },
    onUpdated: {
        addListener: (listener: (id: number, change: { status?: string }) => void) => loaded.push(listener),
        removeListener: (listener: (id: number, change: { status?: string }) => void) => loaded.splice(loaded.indexOf(listener), 1),
    },
};

const executeScript = async (injection: { target: { tabId: number }; func: (...args: never[]) => Promise<Answer> | Answer; args?: never[] }) => {
    const name = injection.func.name;
    // The banner (page/overlay.ts) is the person's to see, not this page's to answer.
    if (name === "flashBanner" || name === "dismissConfirm") {
        return [{ frameId: 0, result: null }];
    }
    // The person's answer to a question asked on the page (asking.ts).
    if (name === "askConfirm") {
        kitBrowser.asked.push(String(injection.args?.[0] ?? ""));
        return [{ frameId: 0, result: kitBrowser.allow }];
    }
    kitBrowser.injected.push(name);
    const result = await injection.func(...(injection.args ?? []));
    if (name === "watchStep" && kitBrowser.lostWatches > 0) {
        kitBrowser.lostWatches -= 1;
        return [{ frameId: 0, result: null }];
    }
    return [{ frameId: 0, result: kitBrowser.loseSendAnswer && name === "sendStep" ? null : result }];
};

// The sandbox's file door (POST /system/webext/file), answering a ticket from `shelf`.
const sandboxFetch = async (_url: string, init?: { body?: string }): Promise<Response> => {
    const { ticket } = object({ ticket: string().default("") }).parse(JSON.parse(init?.body ?? "{}"));
    const file = kitBrowser.shelf.get(ticket);
    return file === undefined
        ? new Response(JSON.stringify({ message: "That ticket is not one this sandbox issued." }), { status: 404 })
        : new Response(file.text, { headers: { "content-type": file.type, "x-intentic-name": encodeURIComponent(file.name) } });
};

const install = (): void => {
    const chrome = {
        storage: { local: area(new Map()), session: area(new Map<string, Stored>([["agentWindows", { [SANDBOX]: 1 }]])) },
        tabs: tabsApi,
        windows: { get: async (id: number) => windowOf(id), update: async () => undefined },
        permissions: { contains: async (request: { origins?: string[] }) => (request.origins ?? []).every((origin) => origin === "https://chatgpt.com/*") },
        action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined, setTitle: async () => undefined, openPopup: async () => undefined },
        runtime: { getManifest: () => ({ version: "0.0.0" }) },
        scripting: { executeScript },
    };
    Object.assign(globalThis, { chrome, fetch: sandboxFetch });
};

// Resolves once the stand-in page has taken a prompt, so a test can change the browser while ChatGPT works.
export const untilSent = async (count = 1): Promise<void> => {
    while ((kitBrowser.fake?.sent.length ?? 0) < count) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

// A fresh browser: one tab of the person's in front, chatgpt.com allowed in read and act, the sandbox paired.
export const resetKitBrowser = async (): Promise<void> => {
    giveEveryElementABox();
    window.intenticChatgpt = undefined;
    document.body.innerHTML = "";
    Object.assign(kitBrowser, {
        tabs: [{ id: 7, windowId: 1, active: true, url: "https://docs.example/notes" }],
        created: [],
        injected: [],
        loseSendAnswer: false,
        lostWatches: 0,
        page: {},
        fake: undefined,
        account: { projects: [] },
        allow: true,
        asked: [],
        shelf: new Map(),
    });
    install();
    await store.addSandbox({ url: SANDBOX, token: "iwx_test", name: "studio" });
    await store.setScopes(SANDBOX, { read: "on", act: "on", screenshot: "off", cookies: "off", scripts: "off", confirm: "sensitive" });
    await store.setMode("https://chatgpt.com/*", "act");
};
