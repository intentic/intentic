// The desktop app as the browser sees it: the app's windows load this SPA and mark themselves via
// `__INTENTIC_DESKTOP__` (injected by Tauri). Everything here builds an `intentic://` link, never IPC, since the
// app intercepts those navigations in Rust; the identical link also works from an external browser via OS routing.
// Nothing here imports Tauri or is desktop-only at runtime, and nothing here runs at import: this module loads
// wherever floating.ts does, node tests included (where to DOWNLOAD the app is desktopDownloads.ts, which does not).

// What the app tells the page about the webview (not about the app): whether this window skips the loopback gate
// (loopback/loopbackPermission.ts). Optional since the SPA ships continuously and the app doesn't; undefined reads as "ask
// the browser", which is correct for an older window that still enforces the check.
interface DesktopWebview {
    version: string;
    installId: string;
    update: string | null;
    loopbackUngated?: boolean;
/* THIS WINDOW HAS NO TITLE BAR OF ITS OWN, so the page draws one. */
    frameless?: boolean;
}

declare global {
    interface Window {
        __INTENTIC_DESKTOP__?: DesktopWebview;
    }
}

// What the app tells the page about itself: version, a per-install random id (the only thread joining this
// window's analytics events to the app's own, since they're separate webviews), and the update already
// downloaded. `update` arrives twice, here and via the event below, for the two orderings of page-load vs.
// download-finish.
export const desktopApp = (): DesktopWebview | undefined => window.__INTENTIC_DESKTOP__;

export const desktopVersion = (): string | undefined => desktopApp()?.version;

// The app announcing, mid-session, that an update finished downloading (update.rs). A plain DOM event: no
// handshake, and a browser with no app simply never fires it.
export const DESKTOP_UPDATE_EVENT = `intentic-desktop-update`;

export interface DesktopUpdateEvent {
    version: string;
}

// Take the offer: the app installs what it downloaded and restarts on it. Unlike the other links, the Rust side
// refuses this one unless it arrives from the app's own window, since it ends the process and runs an installer
// (setup_link.rs).
export const DESKTOP_UPDATE_LINK = `intentic://update`;

/* THE APP ANNOUNCING WHERE THE INSTALL IT IS RUNNING HAS GOT TO (desktop-app's windows.rs `announce_setup`). */
export const DESKTOP_SETUP_EVENT = `intentic-desktop-setup`;

export type DesktopSetupState = `running` | `waiting` | `failed` | `stopped` | `done` | `closed`;

export interface DesktopSetupReport {
    /// The sandbox's name, as the user typed it.
    readonly name?: string;
    readonly state: DesktopSetupState;
    /// 0–100, the app's own weighted bar.
    readonly percent: number;
    /// "Step 4 of 10".
    readonly position?: string;
    /// "about 3 min left".
    readonly remaining?: string;
    /// The running step's phase id, for analytics rather than the screen.
    readonly step?: string;
}

const SETUP_STATES: readonly DesktopSetupState[] = [`running`, `waiting`, `failed`, `stopped`, `done`, `closed`];

/* The event's detail read back as a report, or nothing. */
export const readDesktopSetupReport = (detail: unknown): DesktopSetupReport | undefined => {
    if (detail === null || typeof detail !== `object`) {
        return undefined;
    }
    const raw = detail as Record<string, unknown>;
    const state = SETUP_STATES.find((known) => known === raw[`state`]);
    if (state === undefined || typeof raw[`percent`] !== `number` || !Number.isFinite(raw[`percent`])) {
        return undefined;
    }
    const text = (key: string): string | undefined => (typeof raw[key] === `string` && raw[key] !== `` ? (raw[key] as string) : undefined);
    const name = text(`name`);
    const position = text(`position`);
    const remaining = text(`remaining`);
    const step = text(`step`);
    return {
        state,
        percent: Math.min(100, Math.max(0, raw[`percent`])),
        ...(name === undefined ? {} : { name }),
        ...(position === undefined ? {} : { position }),
        ...(remaining === undefined ? {} : { remaining }),
        ...(step === undefined ? {} : { step }),
    };
};

/* The way back to the app's setup card once "Back to your workspace" has stepped it aside: the same face, holding the same run. */
export const DESKTOP_LAUNCHER_LINK = `intentic://launcher`;

/* `frameless` above says the window arrived without a platform frame; these are the presses that work it. */
export type DesktopWindowVerb = "ready" | "minimize" | "maximize" | "close" | "drag" | "raise";

// The app's own screens (its setup card, its close question) are drawn in whatever light this page announced
// last: it has no way to read this window's localStorage, so the scheme travels as a link, on load and on change.
export const announceDesktopMode = (scheme: `light` | `dark`): void => {
    if (desktopVersion() === undefined) {
        return;
    }
    openDesktopLink(`intentic://window?do=mode&mode=${scheme}`);
};

/* A drag is the one verb that cannot be held back the way `openDesktopLink` holds every early link: it is a press. */
export const workDesktopWindow = (verb: DesktopWindowVerb): void => {
    if (verb === `drag` && !pageLoaded()) {
        return;
    }
    openDesktopLink(`intentic://window?do=${verb}`);
};

/* THE ONE LINK SHAPE THIS WEBVIEW DROPS ON THE FLOOR: `target="_blank"`. */

// The app answers a link out of the page from the webview's new-window event (windows.rs `page_window`), and WebView2
// raises that event for `window.open` and for a NAMED target but never for `_blank`: the click is swallowed inside the
// webview, the app never hears the address, and nothing happens on screen. Re-issued here as the shape the app does
// hear, which is what every `target="_blank"` in the app depends on — provider sign-ins, docs, an agent's markdown link.
const followBlankLink = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0) {
        return;
    }
    const link = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(`a[href]`);
    // A download is the browser's to do in place, and `_blank` is the only target the webview cannot follow itself.
    if (link === null || link === undefined || link.target !== `_blank` || link.hasAttribute(`download`)) {
        return;
    }
    event.preventDefault();
    window.open(link.href);
};

/**
 * Makes `target="_blank"` work for the life of this window. Capture, because a surface whose own handler stops the
 * press from bubbling would otherwise take the link down with it — which also means a `_blank` link is answered here
 * before anything below the document sees the press. A no-op in a browser, where the target needs no help.
 */
export const installDesktopLinks = (): void => {
    if (desktopVersion() === undefined) {
        return;
    }
    document.addEventListener(`click`, followBlankLink, true);
};

/* WHAT A PAGE MAY DO TO ITS OWN WINDOW ONLY IF ITS SCRIPT OPENED IT: close it, raise it, resize it. A browser popup
   qualifies; a window of the app never does (windows.rs builds it), so there each is a link answered on that window. */

export const closeOwnWindow = (): void => {
    if (desktopVersion() === undefined) {
        window.close();
        return;
    }
    workDesktopWindow(`close`);
};

export const raiseOwnWindow = (): void => {
    if (desktopVersion() === undefined) {
        window.focus();
        return;
    }
    workDesktopWindow(`raise`);
};

// Grows the window to `width` CSS pixels at its current height; a window already that wide is left as it is.
export const widenOwnWindow = (width: number): void => {
    if (desktopVersion() === undefined) {
        window.resizeTo(Math.round(width), window.outerHeight);
        return;
    }
    openDesktopLink(`intentic://window?do=fit&width=${Math.round(width)}`);
};

/* The app reports window state to the page through the update-banner DOM event. */
export const DESKTOP_WINDOW_EVENT = `intentic-desktop-window`;

export interface DesktopWindowEvent {
    maximized: boolean;
}

/// Whether this window is one the page has to draw a title bar for.
export const desktopFrameless = (): boolean => desktopApp()?.frameless === true;

export interface DesktopSetupArgs {
    code: string;
    name?: string;
    cfToken?: string;
    syncDir?: string;
    platformUrl?: string;
}

// No `mode` on this link: the script learns its reachability target by redeeming the code, so naming the mode here
// would be a second, driftable copy of that decision. The Cloudflare token rides only inside the desktop webview
// (the nav never reaches the OS); an external deep link can be logged by the protocol handler, so it's omitted
// there.
export const desktopSetupLink = (args: DesktopSetupArgs): string => {
    const params = new URLSearchParams({ code: args.code });
    if (args.name !== undefined && args.name !== ``) {
        params.set(`name`, args.name);
    }
    if (args.cfToken !== undefined && args.cfToken !== `` && desktopVersion() !== undefined) {
        params.set(`cfToken`, args.cfToken);
    }
    if (args.syncDir !== undefined && args.syncDir !== ``) {
        params.set(`syncDir`, args.syncDir);
    }
    if (args.platformUrl !== undefined) {
        params.set(`platform`, args.platformUrl);
    }
    return `intentic://setup?${params.toString()}`;
};

// Signs in via the user's default browser, since Google refuses OAuth from an embedded webview (FedCM isn't
// implemented by WebKitGTK). Credentials return over `intentic://auth`, and the app reopens this SPA at
// /desktop-auth/complete.
export const DESKTOP_SIGN_IN_LINK = `intentic://signin`;

// The credential going back to the app: only the parked row's id and the app's own nonce, never a token. `profile`
// is the look this browser reads the app in (useProfile.ts), so the workspace the app opens wears it too; the
// app's webview is a separate storage and would otherwise open on the default look whatever the reader chose.
export const desktopAuthLink = (handoff: string, state: string, profile?: string): string => {
    const params = new URLSearchParams({ handoff, state });
    if (profile !== undefined) {
        params.set(`profile`, profile);
    }
    return `intentic://auth?${params.toString()}`;
};

export interface DesktopSyncArgs {
    // The sandbox's URL and single-use pairing token, the same two values the card's one-liner carries as
    // SANDBOX_URL/PAIR_TOKEN.
    url: string;
    pair: string;
    /// The sandbox's display name, so the app's screen can say what the folder is being connected to.
    name?: string;
    takeover?: boolean;
    /// A ports-only pairing: the app skips the folder dialog, because there is no folder.
    mirror?: boolean;
}

// Enrolls via a button instead of a pasted one-liner, for the one computer running the app itself. Deliberately no
// folder on the link (the app collects that via a system dialog); the Rust side honors this only from the app's
// own window, since honoring it from any page would let one folder-pick two-way-sync into a sandbox the sender is
// signed into.
export const desktopSyncLink = (args: DesktopSyncArgs): string => {
    const params = new URLSearchParams({ url: args.url, pair: args.pair });
    if (args.name !== undefined && args.name !== ``) {
        params.set(`name`, args.name);
    }
    if (args.takeover === true) {
        params.set(`takeover`, `1`);
    }
    if (args.mirror === true) {
        params.set(`mirror`, `1`);
    }
    return `intentic://sync?${params.toString()}`;
};

// Swaps a sandbox onto a different image: no hash means the fresh `:stable` base, a hash means the owner-approved
// overlay pinned to it, `rollback` means the image before the last update. A rollback sends no digest even if one
// is at hand, since it names a different destination image entirely.
export const desktopRecreateLink = (slug: string, hash?: string, rollback = false): string => {
    const params = new URLSearchParams({ slug });
    if (rollback) {
        params.set(`rollback`, `1`);
    } else if (hash !== undefined && hash !== ``) {
        params.set(`hash`, hash);
    }
    return `intentic://recreate?${params.toString()}`;
};

/* Page load is complete only when the document reports `readyState === "complete"`. */
const pageLoaded = (): boolean => document.readyState === `complete`;

/* A navigation, not a fetch, since that's what the app intercepts. */
export const openDesktopLink = (link: string): void => {
    if (pageLoaded()) {
        globalThis.location.href = link;
        return;
    }
    window.addEventListener(
        `load`,
        () => {
            globalThis.location.href = link;
        },
        { once: true },
    );
};

// Every sign-in surface funnels through here rather than reimplementing "this webview can't ask Google" each time.
// `useGoogleIdentity.renderButton` now refuses in this posture too, so the rule holds even if a caller forgets to
// check.
export const signInThroughBrowser = (): void => openDesktopLink(DESKTOP_SIGN_IN_LINK);
