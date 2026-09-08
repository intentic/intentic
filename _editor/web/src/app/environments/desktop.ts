import { environment } from "./environment";

// The desktop app as the browser sees it: the app's workspace window loads this SPA and marks itself via
// `__INTENTIC_DESKTOP__` (injected by Tauri). Everything here builds an `intentic://` link, never IPC, since the
// app intercepts those navigations in Rust; the identical link also works from an external browser via OS routing.
// Nothing here imports Tauri or is desktop-only at runtime.

// What the app tells the page about the webview (not about the app): whether this window skips the loopback gate
// (loopbackPermission.ts). Optional since the SPA ships continuously and the app doesn't; undefined reads as "ask
// the browser", which is correct for an older window that still enforces the check.
interface DesktopWebview {
    version: string;
    installId: string;
    update: string | null;
    loopbackUngated?: boolean;
    /* THIS WINDOW HAS NO TITLE BAR OF ITS OWN, so the page draws one. The app's window is undecorated
     * (desktop-app windows.rs): the platform's strip carried a logo and three buttons above a product whose own
     * top row is already a full-width bar, and this is the page being told those three buttons are now its to
     * draw (shell/window/WindowControls.vue).
     *
     * OPTIONAL FOR THE REASON THE FLAG ABOVE IS, and this one is load-bearing: the app is a binary somebody
     * installed once and this SPA is deployed continuously, so a window older than the page is an ordinary
     * state. An app that still opens a decorated window never says this word, and the page then draws no
     * controls — where a page that drew them regardless would put a second set of buttons under the first. */
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

/* THE APP ANNOUNCING WHERE THE INSTALL IT IS RUNNING HAS GOT TO (desktop-app's windows.rs `announce_setup`),
 * for the setup page to draw once the app's own card has stepped aside. The same channel as the update, for
 * the same reasons: a DOM event, nothing exposed to the page, and a browser with no app around it simply
 * never hears one. Every tick of the app's own bar arrives here, so the page's copy is as live as the card's.
 *
 * `closed` is not a state of the install but of the card: the user put a finished one away, and the page
 * takes its strip down with it. */
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

/* The event's detail read back as a report, or nothing. It crossed a process boundary as an object the app
 * serialised, and a page must not draw a bar off a shape it never checked: an older or newer app that spells
 * the state differently is a report this page has no screen for, and says nothing rather than something wrong. */
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

/* The way back to the app's setup card once "Back to your workspace" has stepped it aside: the same face,
 * holding the same run. App-window only on the Rust side, like the update: it raises a window of the app,
 * which is the app's own page's business and no outside page's. */
export const DESKTOP_LAUNCHER_LINK = `intentic://launcher`;

/* --- THE TITLE BAR THIS PAGE DRAWS FOR A WINDOW THAT HAS NONE ------------------------------------------
 *
 * `frameless` above says the window arrived without a platform frame; these are the presses that work it.
 * Links, like everything else here, which is what lets a window whose page has NO command surface still be
 * minimised, maximised, closed and DRAGGED by its own bar: `drag` hands the window to the platform's own move
 * loop from Rust, exactly as a Tauri drag region would, and that call is asynchronous either way.
 *
 * `ready` is the page saying its bar is up. It is not decoration: the app opens undecorated and hands the
 * platform's frame BACK if nothing announces one within a few seconds (windows.rs `arm_frame_fallback`), so a
 * page that failed to load, or an app newer than the page it loaded, is a window with a frame rather than a
 * rectangle nobody can move. */
export type DesktopWindowVerb = "ready" | "minimize" | "maximize" | "close" | "drag";

export const workDesktopWindow = (verb: DesktopWindowVerb): void => openDesktopLink(`intentic://window?do=${verb}`);

/* What the app tells the page BACK about the window, on the update banner's channel (a DOM event dispatched by
 * `eval` from Rust) and for the same reason: the maximise button's glyph is a fact about the window, and half
 * the ways a window gets maximised never touch that button — Win+↑, a drag to the top edge, a snap layout. */
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

// A navigation, not a fetch, since that's what the app intercepts. In a browser with no app it's a silent no-op,
// which is why every caller shows download links beside it.
export const openDesktopLink = (link: string): void => {
    globalThis.location.href = link;
};

// Every sign-in surface funnels through here rather than reimplementing "this webview can't ask Google" each time.
// `useGoogleIdentity.renderButton` now refuses in this posture too, so the rule holds even if a caller forgets to
// check.
export const signInThroughBrowser = (): void => openDesktopLink(DESKTOP_SIGN_IN_LINK);

// Download links, chosen by build (like scriptCommand.ts): deploy serves the intentic.dev vanity URLs (site worker
// resolves to the newest release or a staged installer); dev serves the site's own dev server, staged via `pnpm
// --filter @intentic/desktop-app stage:downloads`. File names here are the staged ones, unversioned, since a
// working-tree build has no release version to state.
const DESKTOP_FILES = {
    windows: { vanity: `windows`, file: `Intentic-setup.exe` },
    linuxAppImage: { vanity: `linux`, file: `Intentic.AppImage` },
    linuxDeb: { vanity: `deb`, file: `Intentic.deb` },
    linuxRpm: { vanity: `rpm`, file: `Intentic.rpm` },
} as const;

const downloadUrl = ({ vanity, file }: { vanity: string; file: string }): string =>
    environment.production ? `https://intentic.dev/desktop/${vanity}` : `http://localhost:4321/desktop/${file}`;

export const DESKTOP_DOWNLOADS = {
    windows: downloadUrl(DESKTOP_FILES.windows),
    linuxAppImage: downloadUrl(DESKTOP_FILES.linuxAppImage),
    linuxDeb: downloadUrl(DESKTOP_FILES.linuxDeb),
    linuxRpm: downloadUrl(DESKTOP_FILES.linuxRpm),
} as const;

// The one installer this machine can actually run, or undefined (macOS has no build yet, and a button to nothing
// is worse than the command it'd replace). Reads `userAgentData.platform` or `navigator.platform` (same pair as
// useOsPreference), `startsWith` rather than a `/win/` match since "Darwin" contains "win". Android is excluded by
// hand: it reports "Linux armv8l" through both, and the AppImage isn't for it.
export const desktopInstaller = (): { platform: "windows" | "linux"; label: string; href: string } | undefined => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    if (/android/i.test(nav.userAgent)) {
        return undefined;
    }
    const platform = (nav.userAgentData?.platform ?? nav.platform ?? ``).toLowerCase();
    if (platform.startsWith(`win`)) {
        return { platform: `windows`, label: `Windows`, href: DESKTOP_DOWNLOADS.windows };
    }
    // The AppImage runs across distributions without forcing a package-format choice here; deb/rpm stay on the
    // downloads page.
    if (platform.includes(`linux`)) {
        return { platform: `linux`, label: `Linux`, href: DESKTOP_DOWNLOADS.linuxAppImage };
    }
    return undefined;
};
