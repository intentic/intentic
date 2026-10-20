import { removeStoredValue, storedValue, storeValue } from "../storage/browserStorage";

// THE ANDROID APP'S WEBVIEW. The native app (`dev.intentic.app`, _editor/android-app) draws sign-in, the board, a
// conversation and the menu itself, and shows every other screen of this app in one WebView it keeps warm. It loads a
// route with `?embed=native` (and `&look=`, the look it wears), and from then on this page leaves the way between
// screens to the app: no rail, no back arrow, no edge swipe, and a navigation to a screen the app draws is handed to it
// instead of drawn here (router/nativeHandoff.ts). Without the flag every function here answers "not in the app", so a
// browser, the desktop app and the iOS shell run exactly as before.
//
// Two directions, two globals:
// - the app to this page: `window.intenticEmbed` (router/nativeHandoff.ts), which the app calls with evaluateJavascript,
//   so in the main frame only;
// - this page to the app: `window.intenticNative`, the app's own object. Either an `addJavascriptInterface` object with
//   one method per message, or the object `WebViewCompat.addWebMessageListener` injects, which takes each message as one
//   JSON string through `postMessage`. The app should prefer the second: it is injected only into frames of the
//   origins it names, while an addJavascriptInterface object is in every frame of the WebView, the sandbox's own apps
//   under Browsers included.

export const EMBED_QUERY = `embed`;
export const LOOK_QUERY = `look`;
const EMBED_NATIVE = `native`;
// This tab's session storage: it outlives a reload and every in-app navigation that drops the query, and dies with the
// WebView. Never localStorage: a browser on the same origin must not wake up as the app's.
const EMBED_KEY = `intentic.embed`;
const LOOK_KEY = `intentic.embed.look`;
/** The tab's keys, which a self-heal's wipe keeps (selfHeal.ts). */
export const EMBED_TAB_KEYS: readonly string[] = [EMBED_KEY, LOOK_KEY];

/** The looks the app can hand over: Settings ▸ Appearance's four (features/settings/themeRow.ts). */
export const NATIVE_LOOKS = [`system`, `light`, `dark`, `sanctum`] as const;
export type NativeLook = (typeof NATIVE_LOOKS)[number];

/** A look by name, as an address, the tab or the app spells it; undefined for any other word. */
export const nativeLookOf = (value: string | null | undefined): NativeLook | undefined => NATIVE_LOOKS.find((look) => look === value);

/** What this page tells the app. Through `postMessage` it is this object as JSON; through methods, `kind` is the method. */
export type NativeMessage =
    | { readonly kind: `open`; readonly path: string }
    | { readonly kind: `signOut` }
    | { readonly kind: `setLook`; readonly look: NativeLook }
    | { readonly kind: `routed`; readonly path: string; readonly title: string; readonly canGoBack: boolean }
    // Words a page offered for a conversation's composer (`intentic.send` on a page shown full screen): the app opens that
    // conversation with them after whatever is written there, never sent.
    | { readonly kind: `compose`; readonly conversationId: string; readonly text: string };

/** The app's object, as either injection presents it. Every member is optional: this page ships ahead of app builds. */
export interface IntenticNative {
    open?(path: string): void;
    signOut?(): void;
    look?(): string;
    setLook?(look: string): void;
    routed?(path: string, title: string, canGoBack: boolean): void;
    compose?(conversationId: string, text: string): void;
    postMessage?(message: string): void;
}

declare global {
    interface Window {
        intenticNative?: IntenticNative;
    }
}

// What the tab keeps, through the one door to browser storage (its session area: this tab's, surviving its reloads).
const read = (key: string): string | undefined => storedValue(key, `session`);
const write = (key: string, value: string | undefined): void => {
    if (value === undefined) {
        removeStoredValue(key, `session`);
    } else {
        storeValue(key, value, `session`);
    }
};

/**
 * Whether this page is the app's, read off its address and what this tab remembers: `?embed=native` turns it on and the
 * tab keeps it, any other `?embed=` turns it off and forgets it, and an address without one is whatever the tab
 * remembers. The look an address names (`&look=`) is kept beside it, for a reload whose address no longer says.
 */
export const readEmbed = (search: string): boolean => {
    const query = new URLSearchParams(search);
    const asked = query.get(EMBED_QUERY);
    const on = asked === null ? read(EMBED_KEY) === EMBED_NATIVE : asked === EMBED_NATIVE;
    if (asked !== null) {
        write(EMBED_KEY, on ? EMBED_NATIVE : undefined);
    }
    const look = nativeLookOf(query.get(LOOK_QUERY));
    if (!on) {
        write(LOOK_KEY, undefined);
    } else if (look !== undefined) {
        write(LOOK_KEY, look);
    }
    return on;
};

// allow(module-state): read once per page, from the address it was loaded at, before the router drops the query.
let mode: boolean | undefined;

/** Whether this page is in the Android app's WebView. */
export const embedded = (): boolean => (mode ??= readEmbed(globalThis.location?.search ?? ``));

const app = (): IntenticNative | undefined => (embedded() ? globalThis.window?.intenticNative : undefined);

/** The look the app wears: what its object says now, else the one it last named for this tab. Undefined outside it. */
export const nativeLook = (): NativeLook | undefined => {
    if (!embedded()) {
        return undefined;
    }
    try {
        const said = nativeLookOf(app()?.look?.());
        if (said !== undefined) {
            return said;
        }
    } catch (error) {
        console.warn(`[native] the app's look() threw:`, error);
    }
    return nativeLookOf(read(LOOK_KEY));
};

/** Keeps a look the app handed over later (`intenticEmbed.setLook`), so a reload opens in it too. */
export const rememberLook = (look: NativeLook): void => write(LOOK_KEY, look);

// One method per message, called on the app's object itself: an injected Java method refuses a detached call. False when
// the object has no such method, so the message goes as JSON instead.
const byMethod = (native: IntenticNative, message: NativeMessage): boolean => {
    switch (message.kind) {
        case `open`:
            native.open?.(message.path);
            return native.open !== undefined;
        case `signOut`:
            native.signOut?.();
            return native.signOut !== undefined;
        case `setLook`:
            native.setLook?.(message.look);
            return native.setLook !== undefined;
        case `routed`:
            native.routed?.(message.path, message.title, message.canGoBack);
            return native.routed !== undefined;
        case `compose`:
            native.compose?.(message.conversationId, message.text);
            return native.compose !== undefined;
    }
};

/** Tells the app; false outside it, or when it hears this message neither way, so the caller does what a browser does. */
export const tellNative = (message: NativeMessage): boolean => {
    const native = app();
    if (native === undefined) {
        return false;
    }
    try {
        if (byMethod(native, message)) {
            return true;
        }
        if (native.postMessage === undefined) {
            return false;
        }
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- the app's injected object takes the message alone; its origin rules are set where the app injects it.
        native.postMessage(JSON.stringify(message));
        return true;
    } catch (error) {
        console.warn(`[native] the app refused ${message.kind}:`, error);
        return false;
    }
};
