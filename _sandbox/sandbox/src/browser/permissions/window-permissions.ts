import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import {
    BROWSER_PERMISSIONS,
    type BrowserPermission,
    type BrowserPermissionAsk,
    type Geolocation,
    type PermissionSetting,
    type SitePermissions,
} from "@intentic/sandbox-contract/schemas/browser-tools";
import type { Browser, CDPSession, Page } from "playwright";
import { opt } from "../../opt.js";
import { askScript, parseAskMessage } from "./ask-script.js";
import { filePermissionStore, memoryPermissionStore, type PermissionStore, permissionsPath } from "./permission-store.js";

// What sites may do in one browser window, and the asks it is waiting on: the person answers them in the editor, which
// draws its own prompt where Chromium's bubble would be (ask-script.ts says why Chromium's cannot be used). A decision is
// remembered for the site in the window's profile (permission-store.ts) and set on Chromium as a DevTools override
// (Browser.setPermission), which every page of the profile then reads: Notification.permission,
// navigator.permissions.query, the lookup itself.

// How long a page waits on a person who never answers before its ask is let go undecided ("default"), as dismissing
// Chromium's own bubble does.
const ASK_TIMEOUT_MS = 5 * 60_000;
// One notification per site this often at most: a page that loops on `new Notification` buzzes once.
const NOTIFY_EVERY_MS = 5_000;
// The camera-and-microphone note stays this long unless dismissed: it reports something that already happened.
const UNAVAILABLE_MS = 30_000;

export interface PermissionsConfig {
    // The workspace root, where each profile's decisions are kept; without one they last as long as the window.
    readonly root?: string | undefined;
    // An allowed site's notification, as one of Intentic's own.
    readonly notify?: ((notification: { readonly origin: string; readonly title: string; readonly body: string }) => void) | undefined;
}

let config: PermissionsConfig = {};

/** Where decisions are kept and where notifications go; set once as the daemon's routes are built. */
export const configurePermissions = (next: PermissionsConfig): void => {
    config = next;
};

interface PendingAsk {
    readonly id: string;
    readonly pageId: string;
    readonly origin: string;
    readonly permission: BrowserPermission;
    readonly unavailable: boolean;
    // Answers the page; absent for a note that only says what happened.
    readonly settle: ((answer: "granted" | "denied" | "default") => void) | undefined;
    readonly timer: ReturnType<typeof setTimeout>;
}

// A window as this module needs it: browser-sessions.ts's record, by the fields read here.
export interface PermissionWindow {
    readonly name: string;
    readonly server: string;
    readonly browser: Browser | undefined;
}

interface WindowPermissions {
    readonly store: PermissionStore;
    readonly browserSession: Promise<CDPSession | undefined>;
    readonly asks: PendingAsk[];
    // Each open page's DevTools session, by page id: where a location is set and site data is cleared.
    readonly pages: Map<string, CDPSession>;
    location: Geolocation | undefined;
    readonly notified: Map<string, number>;
    readonly changed: () => void;
}

const windows = new WeakMap<PermissionWindow, WindowPermissions>();
// One store per profile file, so two windows of a profile read and write one queue.
const stores = new Map<string, PermissionStore>();

const storeFor = (profile: string): PermissionStore => {
    const root = config.root;
    if (root === undefined) {
        return memoryPermissionStore();
    }
    const path = permissionsPath(root, profile);
    const known = stores.get(path);
    if (known !== undefined) {
        return known;
    }
    const store = filePermissionStore(path);
    stores.set(path, store);
    return store;
};

const CHROMIUM_SETTING = { allow: "granted", block: "denied", ask: "prompt" } as const;

const override = async (state: WindowPermissions, origin: string, permission: BrowserPermission, setting: PermissionSetting): Promise<void> => {
    const session = await state.browserSession;
    await session?.send("Browser.setPermission", { permission: { name: permission }, setting: CHROMIUM_SETTING[setting], origin });
};

// Every standing decision of the profile, set on the browser that just started: overrides do not outlive a session.
const applyStored = async (state: WindowPermissions): Promise<void> => {
    for (const [origin, site] of Object.entries(await state.store.sites())) {
        for (const permission of BROWSER_PERMISSIONS) {
            const setting = site[permission];
            if (setting !== undefined) {
                // allow(silent-catch): an origin Chromium refuses to key an override on (an opaque one) has no decision to keep.
                await override(state, origin, permission, setting).catch(() => undefined);
            }
        }
    }
};

/** Starts answering for a window; `changed` hears an ask arriving or going. Once per window, whatever calls it again. */
export const armWindowPermissions = (window: PermissionWindow, changed: () => void): void => {
    if (windows.has(window)) {
        return;
    }
    const state: WindowPermissions = {
        store: storeFor(window.server),
        // allow(silent-catch): a browser gone before its session opened has nothing to grant.
        browserSession: window.browser?.newBrowserCDPSession().catch(() => undefined) ?? Promise.resolve(undefined),
        asks: [],
        pages: new Map(),
        location: undefined,
        notified: new Map(),
        changed,
    };
    windows.set(window, state);
    void applyStored(state);
};

const removeAsk = (state: WindowPermissions, ask: PendingAsk): void => {
    const at = state.asks.indexOf(ask);
    if (at >= 0) {
        state.asks.splice(at, 1);
        clearTimeout(ask.timer);
        state.changed();
    }
};

// A site's origin as permissions are kept for it: a web page's, never an opaque one (`null`), a file or an extension.
const WebOriginSchema = z.string().regex(/^https?:\/\/[^/]+$/u);

// The site a call came from: the frame's own origin, read in the frame that made it. Unforgeable there (Location is),
// so a page cannot ask in another site's name.
const originOf = async (session: CDPSession, contextId: number): Promise<string | undefined> => {
    const answer = await session
        .send("Runtime.evaluate", { expression: "location.origin", contextId, returnByValue: true })
        // allow(silent-catch): a frame gone as it asked has no origin left to answer for.
        .catch(() => undefined);
    const origin = WebOriginSchema.safeParse(answer?.result.value);
    return origin.success ? origin.data : undefined;
};

const notify = (state: WindowPermissions, origin: string, title: string, body: string): void => {
    const last = state.notified.get(origin) ?? 0;
    if (Date.now() - last < NOTIFY_EVERY_MS) {
        return;
    }
    state.notified.set(origin, Date.now());
    config.notify?.({ origin, title, body });
};

const hold = (state: WindowPermissions, ask: Omit<PendingAsk, "timer">, timeoutMs: number): void => {
    const pending: PendingAsk = {
        ...ask,
        timer: setTimeout(() => {
            removeAsk(state, pending);
            pending.settle?.("default");
        }, timeoutMs),
    };
    state.asks.push(pending);
    state.changed();
};

const onMessage = async (state: WindowPermissions, page: { readonly id: string; readonly session: CDPSession }, payload: string, contextId: number, reply: string): Promise<void> => {
    const message = parseAskMessage(payload);
    if (message === undefined) {
        return;
    }
    const origin = await originOf(page.session, contextId);
    const answer = (id: number, value: "granted" | "denied" | "default"): void => {
        void page.session
            .send("Runtime.evaluate", { expression: `globalThis[${JSON.stringify(reply)}](${String(id)}, ${JSON.stringify(value)})`, contextId })
            // allow(silent-catch): a frame that navigated away has no one waiting for the answer.
            .catch(() => undefined);
    };
    if (message.type === "notify") {
        if (origin !== undefined && (await state.store.settingOf(origin, "notifications")) === "allow") {
            notify(state, origin, message.title, message.body);
        }
        return;
    }
    if (origin === undefined) {
        if (message.type === "ask") {
            answer(message.id, "denied");
        }
        return;
    }
    if (message.type === "unavailable") {
        if (!state.asks.some((ask) => ask.unavailable && ask.origin === origin && ask.permission === message.permission)) {
            hold(state, { id: randomUUID(), pageId: page.id, origin, permission: message.permission, unavailable: true, settle: undefined }, UNAVAILABLE_MS);
        }
        return;
    }
    const setting = await state.store.settingOf(origin, message.permission);
    if (setting !== "ask") {
        // Set again on the way: an override the session dropped (a browser restarted under a long-lived page) is back.
        // allow(silent-catch): the stored answer is what the page gets either way.
        await override(state, origin, message.permission, setting).catch(() => undefined);
        answer(message.id, setting === "allow" ? "granted" : "denied");
        return;
    }
    hold(
        state,
        { id: randomUUID(), pageId: page.id, origin, permission: message.permission, unavailable: false, settle: (value) => answer(message.id, value) },
        ASK_TIMEOUT_MS,
    );
};

const setLocation = async (state: WindowPermissions, location: Geolocation): Promise<void> => {
    state.location = location;
    for (const session of state.pages.values()) {
        // allow(silent-catch): a page closing as the location is set needs none.
        await session.send("Emulation.setGeolocationOverride", { ...location }).catch(() => undefined);
    }
};

/**
 * Makes one page's asks this window's: installs the ask script (ask-script.ts) on the page's own DevTools session,
 * before the page's next document and in the one it has now. A page of a window that was never armed is left alone.
 */
export const armPageAsks = async (window: PermissionWindow, page: Page, pageId: string, session: CDPSession): Promise<void> => {
    const state = windows.get(window);
    if (state === undefined) {
        return;
    }
    // Random per page: nothing a site could guess, or find on a page of another site to collide with.
    const names = { binding: `__${randomBytes(9).toString("base64url")}`, reply: `__${randomBytes(9).toString("base64url")}` };
    state.pages.set(pageId, session);
    page.once("close", () => {
        state.pages.delete(pageId);
        for (const ask of state.asks.filter((pending) => pending.pageId === pageId)) {
            removeAsk(state, ask);
        }
    });
    // A page that leaves for another address leaves its questions behind; the new one asks its own.
    page.on("framenavigated", (frame) => {
        if (frame.parentFrame() === null) {
            for (const ask of state.asks.filter((pending) => pending.pageId === pageId && !pending.unavailable)) {
                removeAsk(state, ask);
            }
        }
    });
    session.on("Runtime.bindingCalled", (event: { name: string; payload: string; executionContextId: number }) => {
        if (event.name === names.binding) {
            void onMessage(state, { id: pageId, session }, event.payload, event.executionContextId, names.reply);
        }
    });
    await session.send("Runtime.enable");
    await session.send("Runtime.addBinding", { name: names.binding });
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source: askScript(names), runImmediately: true });
    if (state.location !== undefined) {
        await session.send("Emulation.setGeolocationOverride", { ...state.location });
    }
};

/** The ask the window shows first, if it is waiting on one. */
export const permissionAskOf = (window: PermissionWindow): BrowserPermissionAsk | undefined => {
    const ask = windows.get(window)?.asks[0];
    return ask === undefined
        ? undefined
        : { id: ask.id, pageId: ask.pageId, origin: ask.origin, permission: ask.permission, ...opt("unavailable", ask.unavailable ? (true as const) : undefined) };
};

export class NotArmed extends Error {
    constructor() {
        super("this browser window does not answer permissions");
    }
}

const stateOf = (window: PermissionWindow): WindowPermissions => {
    const state = windows.get(window);
    if (state === undefined) {
        throw new NotArmed();
    }
    return state;
};

/** Changes a site's standing answer, from the next time it asks; a location comes with allowing geolocation. */
export const setSitePermission = async (
    window: PermissionWindow,
    input: { readonly origin: string; readonly permission: BrowserPermission; readonly setting: PermissionSetting; readonly location?: Geolocation | undefined },
): Promise<void> => {
    const state = stateOf(window);
    await state.store.set(input.origin, input.permission, input.setting);
    await override(state, input.origin, input.permission, input.setting);
    if (input.location !== undefined && input.permission === "geolocation" && input.setting === "allow") {
        await setLocation(state, input.location);
    }
};

/**
 * Answers the ask `id`, and with it every other one the window holds from the same site for the same permission. A
 * note about a device the sandbox lacks is only dismissed: there is nothing to decide.
 */
export const answerPermissionAsk = async (
    window: PermissionWindow,
    id: string,
    setting: "allow" | "block",
    location?: Geolocation | undefined,
): Promise<void> => {
    const state = stateOf(window);
    const ask = state.asks.find((pending) => pending.id === id);
    if (ask === undefined) {
        return;
    }
    if (ask.unavailable) {
        removeAsk(state, ask);
        return;
    }
    await setSitePermission(window, { origin: ask.origin, permission: ask.permission, setting, location });
    for (const same of state.asks.filter((pending) => pending.origin === ask.origin && pending.permission === ask.permission && !pending.unavailable)) {
        removeAsk(state, same);
        same.settle?.(setting === "allow" ? "granted" : "denied");
    }
};

/** What a site may do in this window's profile. */
export const sitePermissions = async (window: PermissionWindow, origin: string): Promise<SitePermissions> => {
    const state = stateOf(window);
    const permissions = await Promise.all(
        BROWSER_PERMISSIONS.map(async (permission) => ({ permission, setting: await state.store.settingOf(origin, permission) })),
    );
    return { origin, permissions, location: state.location !== undefined };
};

/** Deletes everything a site keeps in the window's profile: cookies, storage, caches, service workers. */
export const clearSiteData = async (window: PermissionWindow, origin: string): Promise<void> => {
    const state = stateOf(window);
    const [session] = state.pages.values();
    if (session === undefined) {
        throw new NotArmed();
    }
    // A page's session, not the browser's: Chromium answers the browser-level call with an internal error.
    await session.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
};
