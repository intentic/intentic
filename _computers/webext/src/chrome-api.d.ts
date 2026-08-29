/* THE SLICE OF CHROME THIS EXTENSION TOUCHES, declared by hand.
 *
 * Not @types/chrome, and the reason is the same one that makes this file worth reading: an extension is judged
 * — by a Web Store reviewer, and by the person installing it — on exactly which browser APIs it reaches for.
 * The ambient package declares all of them, so nothing in a type error ever tells you that a new call reached
 * into a new capability. Here, using an API this file does not declare is a compile error, and adding it is a
 * diff somebody has to justify. That is the property worth more than the convenience.
 *
 * Everything below is what manifest.json's `permissions` already announce, and nothing else: storage, scripting,
 * alarms, cookies, the action badge, and the tabs surface that works WITHOUT the `tabs` permission (see
 * `tabs.query` — url and title arrive only for origins the person granted, which is not a limitation to work
 * around but the privacy property this connector is built on). */

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
        /* The one call that reaches into a page. `func` is SERIALIZED and re-parsed in the tab, so it may not
         * close over anything in this bundle — see page/driver.ts, where every injected function is written to
         * that rule. Chrome refuses the call outright for a tab whose origin was never granted, which is the
         * layer of enforcement below this extension's own. */
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
    }

    namespace action {
        function setBadgeText(details: { text: string }): Promise<void>;
        function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
        function setTitle(details: { title: string }): Promise<void>;
    }
}
