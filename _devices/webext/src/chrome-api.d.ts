/* THE SLICE OF CHROME THIS EXTENSION TOUCHES, declared by hand. */

declare namespace chrome {
    namespace runtime {
        const id: string;
        const lastError: { message?: string } | undefined;
        function getManifest(): { version: string; name: string };
        function getURL(path: string): string;
        const onInstalled: { addListener: (callback: (details?: { readonly reason: "install" | "update" | "chrome_update" | "shared_module_update" }) => void) => void };
        const onStartup: { addListener: (callback: () => void) => void };
        const onMessage: {
            addListener: (
                callback: (message: unknown, sender: { tab?: { id?: number }; url?: string }, respond: (answer: unknown) => void) => boolean | void,
            ) => void;
        };
        function sendMessage(message: unknown): Promise<unknown>;
        // Messages from user scripts arrive here, never on onMessage; present only while the userScripts API is.
        const onUserScriptMessage:
            | {
                  addListener: (
                      callback: (message: UserScriptMessageIn, sender: { tab?: { id?: number }; url?: string; frameId?: number }, respond: (answer: UserScriptAnswer) => void) => boolean | void,
                  ) => void;
              }
            | undefined;
        function connectNative(name: string): Port;
        interface Port {
            postMessage(message: unknown): void;
            disconnect(): void;
            onMessage: { addListener(callback: (message: unknown) => void): void; removeListener(callback: (message: unknown) => void): void };
            onDisconnect: { addListener(callback: () => void): void; removeListener(callback: () => void): void };
        }
        interface MessageSender {
            tab?: tabs.Tab;
            url?: string;
        }
    }

    // What a user script's world sent: a less-trusted context, so nothing reads a field of it before
    // background/scripts/runtime.ts has parsed it.
    type UserScriptMessageIn = unknown;
    // What the worker answers a user script: JSON only, since it crosses into the page's world.
    type UserScriptJson = string | number | boolean | null | readonly UserScriptJson[] | { readonly [key: string]: UserScriptJson };
    interface UserScriptAnswer {
        readonly ok: boolean;
        readonly message?: string;
        readonly value?: UserScriptJson;
    }

    namespace extension {
        const inIncognitoContext: boolean;
    }

    namespace storage {
        interface Area {
            get(keys: string[] | null): Promise<Record<string, unknown>>;
            set(items: Record<string, unknown>): Promise<void>;
            remove(keys: string[]): Promise<void>;
        }
        const local: Area;
        // Cleared when the browser quits: where a window id is kept, since ids start over in the next run.
        const session: Area;
        // Lets an open popup follow what the worker writes (a new request, the agent's next call) without polling.
        const onChanged: { addListener: (callback: (changes: Record<string, unknown>, area: string) => void) => void };
    }

    namespace alarms {
        function create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): void;
        const onAlarm: { addListener: (callback: (alarm: { name: string }) => void) => void };
    }

    namespace permissions {
        function getAll(): Promise<{ origins?: string[]; permissions?: string[] }>;
        function contains(request: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
        // Only ever resolves true when called from a user gesture in an extension page: the whole reason the
        // agent cannot grant itself a site, and asks the popup to ask the person instead.
        function request(request: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
        function remove(request: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
        const onRemoved: { addListener: (callback: (removed: { origins?: string[]; permissions?: string[] }) => void) => void };
        const onAdded: { addListener: (callback: (added: { origins?: string[]; permissions?: string[] }) => void) => void };
    }

    namespace tabs {
        interface Tab {
            incognito?: boolean;
            id?: number;
            windowId?: number;
            active?: boolean;
            // Present ONLY for a tab whose origin this extension holds a host permission for. Undefined is the
            // ordinary case for everything the person has not granted, and is reported as such.
            url?: string;
            title?: string;
            status?: string;
            // Unloaded by the browser to save memory; its page comes back only when it is shown or reloaded.
            discarded?: boolean;
        }
        function query(query: { active?: boolean; currentWindow?: boolean; windowId?: number }): Promise<Tab[]>;
        function get(tabId: number): Promise<Tab>;
        // `autoDiscardable: false` keeps a tab whose page holds state the site cannot load back (a site kit's temporary chat).
        function update(tabId: number, properties: { url?: string; active?: boolean; autoDiscardable?: boolean }): Promise<Tab>;
        function create(properties: { url?: string; active?: boolean; windowId?: number }): Promise<Tab>;
        function captureVisibleTab(windowId: number, options: { format: "png" | "jpeg"; quality?: number }): Promise<string>;
        // Needed after a session is written into this browser's cookie store: a page already open is still
        // showing the old one, and nothing about setting a cookie tells it otherwise (tools/lend.ts).
        function reload(tabId: number): Promise<void>;
        // A sign-in's dead-end tab, closed once its address is caught (background/loopback-catch.ts).
        function remove(tabId: number): Promise<void>;
        // Where a sign-in's redirect is watched for; `url` rides on the change only for a tab this extension may read.
        const onUpdated: {
            addListener: (callback: (tabId: number, change: { url?: string; status?: string }, tab: Tab) => void) => void;
            removeListener: (callback: (tabId: number, change: { url?: string; status?: string }, tab: Tab) => void) => void;
        };
    }

    // The agent's own window (background/agent-window.ts). No permission: the windows API needs none.
    namespace windows {
        type State = "normal" | "minimized" | "maximized" | "fullscreen" | "locked-fullscreen";
        interface Window {
            id?: number;
            focused: boolean;
            state?: State;
            left?: number;
            top?: number;
            width?: number;
            height?: number;
            // Present when asked for with `populate`, and on a window `create` answers with.
            tabs?: tabs.Tab[];
        }
        // `focused: false` is honoured; `state: "minimized"` is not by Brave, which opens a normal, focused window
        // instead (measured 2026-10-28), so it is not offered here.
        function create(data: { url?: string; focused?: boolean; left?: number; top?: number; width?: number; height?: number }): Promise<Window>;
        function get(windowId: number, options?: { populate?: boolean }): Promise<Window>;
        // `drawAttention` flashes the window's taskbar button without moving focus.
        function update(
            windowId: number,
            info: { focused?: boolean; drawAttention?: boolean; state?: "normal" | "minimized" | "maximized" },
        ): Promise<Window>;
        const onRemoved: { addListener: (callback: (windowId: number) => void) => void };
        const onBoundsChanged: { addListener: (callback: (window: Window) => void) => void };
    }

    namespace scripting {
        interface InjectionTarget {
            tabId: number;
            allFrames?: boolean;
        }
        interface InjectionResult<T> {
            // `null` when the function threw in the page or its frame went away before a returned promise settled.
            result?: T | null;
            frameId: number;
        }
/* The one call that reaches into a page. */
        function executeScript<Args extends unknown[], Result>(injection: {
            target: InjectionTarget;
            func: (...args: Args) => Result;
            args?: Args;
            world?: "ISOLATED" | "MAIN";
        }): Promise<InjectionResult<Awaited<Result>>[]>;
        interface RegisteredContentScript {
            id: string;
            matches?: string[];
            excludeMatches?: string[];
            js?: string[];
            runAt?: "document_idle" | "document_start" | "document_end";
            persistAcrossSessions?: boolean;
        }
        function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
        function updateContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
        function unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
        function getRegisteredContentScripts(filter: { ids: string[] }): Promise<RegisteredContentScript[]>;
    }

    // User scripts (background/scripts/): code the agent wrote and the person installed. Undefined until the extension
    // holds the optional `userScripts` permission AND the person turned on "Allow User Scripts" on its details page
    // (Developer mode before Chrome 138), so it is read as possibly absent everywhere.
    interface UserScriptSource {
        code: string;
    }
    interface RegisteredUserScript {
        id: string;
        matches?: string[];
        excludeMatches?: string[];
        js?: UserScriptSource[];
        runAt?: "document_start" | "document_end" | "document_idle";
        allFrames?: boolean;
        world?: "USER_SCRIPT" | "MAIN";
        // Chrome 133: each script in a world of its own, so one script's globals and content security policy are its own.
        worldId?: string;
    }
    interface UserScriptsApi {
        register(scripts: RegisteredUserScript[]): Promise<void>;
        update(scripts: RegisteredUserScript[]): Promise<void>;
        unregister(filter?: { ids?: string[] }): Promise<void>;
        getScripts(filter?: { ids?: string[] }): Promise<RegisteredUserScript[]>;
        configureWorld(properties: { worldId?: string; csp?: string; messaging?: boolean }): Promise<void>;
        resetWorldConfiguration?(worldId?: string): Promise<void>;
        // Chrome 135: once, in one tab. A script that throws, or does not parse, answers `result: null` with no `error`
        // (measured on Chrome 156), which is why script_try reports from inside the page (scripts/runtime.ts).
        execute?(injection: {
            target: { tabId: number; frameIds?: number[] };
            js: UserScriptSource[];
            worldId?: string;
            injectImmediately?: boolean;
        }): Promise<{ documentId?: string; frameId: number; result?: unknown; error?: string }[]>;
    }
    const userScripts: UserScriptsApi | undefined;

    namespace cookies {
        interface Cookie {
            name: string;
            value: string;
            domain: string;
            path: string;
            secure: boolean;
            httpOnly: boolean;
            sameSite: "no_restriction" | "lax" | "strict" | "unspecified";
            expirationDate?: number;
            session: boolean;
        }
        function getAll(details: { domain?: string; url?: string }): Promise<Cookie[]>;
/* Writing one, for the session a sandbox account lends to this browser (tools/lend.ts). */
        function set(details: {
            url: string;
            name: string;
            value: string;
            domain?: string;
            path?: string;
            secure?: boolean;
            httpOnly?: boolean;
            sameSite?: "no_restriction" | "lax" | "strict" | "unspecified";
            expirationDate?: number;
        }): Promise<Cookie | null>;
    }

    namespace action {
        function setBadgeText(details: { text: string }): Promise<void>;
        function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
        // Chrome 110; optional so a fake without it (the tests) still type-checks.
        const setBadgeTextColor: ((details: { color: string }) => Promise<void>) | undefined;
        function setTitle(details: { title: string }): Promise<void>;
        // Without a user gesture from Chrome 127 (policy-installed only before that, where it rejects); absent in
        // browsers that never shipped it. Opens in the window in front, and rejects when there is none.
        const openPopup: ((options?: { windowId?: number }) => Promise<void>) | undefined;
    }
}

/* Brave's one addition to the platform, and the only way to tell it apart: its user agent is Chrome's, deliberately. */
interface Navigator {
    readonly brave?: { isBrave: () => Promise<boolean> };
}
