/* THE SLICE OF CHROME THIS EXTENSION TOUCHES, declared by hand. */

declare namespace chrome {
    namespace runtime {
        const id: string;
        const lastError: { message?: string } | undefined;
        function getManifest(): { version: string; name: string };
        function getURL(path: string): string;
        const onInstalled: { addListener: (callback: () => void) => void };
        const onStartup: { addListener: (callback: () => void) => void };
        const onMessage: {
            addListener: (
                callback: (message: unknown, sender: { tab?: { id?: number }; url?: string }, respond: (answer: unknown) => void) => boolean | void,
            ) => void;
        };
        function sendMessage(message: unknown): Promise<unknown>;
    }

    namespace storage {
        interface Area {
            get(keys: string[] | null): Promise<Record<string, unknown>>;
            set(items: Record<string, unknown>): Promise<void>;
            remove(keys: string[]): Promise<void>;
        }
        const local: Area;
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
        const onRemoved: { addListener: (callback: (removed: { origins?: string[] }) => void) => void };
        const onAdded: { addListener: (callback: (added: { origins?: string[] }) => void) => void };
    }

    namespace tabs {
        interface Tab {
            id?: number;
            windowId?: number;
            active?: boolean;
            // Present ONLY for a tab whose origin this extension holds a host permission for. Undefined is the
            // ordinary case for everything the person has not granted, and is reported as such.
            url?: string;
            title?: string;
            status?: string;
        }
        function query(query: { active?: boolean; currentWindow?: boolean; windowId?: number }): Promise<Tab[]>;
        function get(tabId: number): Promise<Tab>;
        function update(tabId: number, properties: { url?: string; active?: boolean }): Promise<Tab>;
        function create(properties: { url?: string; active?: boolean }): Promise<Tab>;
        function captureVisibleTab(windowId: number, options: { format: "png" | "jpeg"; quality?: number }): Promise<string>;
        // Needed after a session is written into this browser's cookie store: a page already open is still
        // showing the old one, and nothing about setting a cookie tells it otherwise (tools/lend.ts).
        function reload(tabId: number): Promise<void>;
    }

    namespace scripting {
        interface InjectionTarget {
            tabId: number;
            allFrames?: boolean;
        }
        interface InjectionResult<T> {
            result?: T;
            frameId: number;
        }
/* The one call that reaches into a page. */
        function executeScript<Args extends unknown[], Result>(injection: {
            target: InjectionTarget;
            func: (...args: Args) => Result;
            args?: Args;
            world?: "ISOLATED" | "MAIN";
        }): Promise<InjectionResult<Awaited<Result>>[]>;
    }

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
