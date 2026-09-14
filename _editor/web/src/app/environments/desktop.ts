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
export type DesktopWindowVerb = "ready" | "minimize" | "maximize" | "close" | "drag";

/* A drag is the one verb that cannot be held back the way `openDesktopLink` holds every early link: it is a press. */
export const workDesktopWindow = (verb: DesktopWindowVerb): void => {
    if (verb === `drag` && !pageLoaded()) {
        return;
    }
    openDesktopLink(`intentic://window?do=${verb}`);
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
