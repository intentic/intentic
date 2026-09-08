import { environment } from "./environment";

/* THE DESKTOP APP, AS THE BROWSER SEES IT (_editor/desktop-app).
 *
 * The app's workspace window loads this very SPA and marks itself with `__INTENTIC_DESKTOP__`, injected by a
 * Tauri initialization script. Everything this module builds is an `intentic://` LINK, never IPC: the app
 * intercepts those navigations in Rust, so remote content gets no command surface at all, and the identical
 * link works from an external browser, where the OS routes it to the installed app. Nothing here imports
 * Tauri, and nothing here is desktop-only at runtime; a plain browser just gets links nobody handles.
 *
 * Which is also why this file is about THREE cards rather than one. The app replaces a terminal in three
 * places, and only the first is onboarding:
 *   • Setup step 3, "run this install command on the machine" → Run on this computer
 *   • the Update card, the sandbox holds no host Docker socket, so it can NEVER recreate its own container
 *   • the Environment card, the same, for an owner-approved overlay
 * The last two are the ones a user meets over and over, which is the real argument for the app existing. */

/* What the app tells the page about the webview it is standing in, as opposed to about the app: this window
 * does not gate the reach for loopback, so the page may dial the sandbox on this machine without asking anyone
 * first (loopbackPermission.ts).
 *
 * OPTIONAL BECAUSE THE TWO SIDES SHIP SEPARATELY. This SPA is deployed continuously and the app is a binary
 * somebody installed once, so an older window is an ordinary state rather than a legacy one — and it says
 * nothing here, which reads as "ask the browser", which is exactly right for a webview that still enforces the
 * check. */
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

/* What the app tells the page about itself: the version, a random id for that installation of the app, and the
 * version it has ALREADY DOWNLOADED and is one restart away from running.
 *
 * The id is the only thread between this window's events and the ones the app's own screens report, two
 * webviews with separate storage, which analytics would otherwise read as two unrelated people (analytics.ts).
 *
 * `update` is the newest of the three and the only one that changes after load, so it arrives twice: here for
 * a page that loads after the download finished, and on the event below for a page that was already open when
 * it did. Neither is IPC — the app injects both, and the page's only way back is the `intentic://` link. */
export const desktopApp = (): DesktopWebview | undefined => window.__INTENTIC_DESKTOP__;

export const desktopVersion = (): string | undefined => desktopApp()?.version;

/* The app announcing, mid-session, that the next version is downloaded and waiting (desktop-app's update.rs).
 * A plain DOM event because that is the widest one-way channel there is: no handshake, nothing exposed to the
 * page, and a browser with no app around it simply never fires it. */
export const DESKTOP_UPDATE_EVENT = `intentic-desktop-update`;

export interface DesktopUpdateEvent {
    version: string;
}

/* Take the offer: the app installs what it has downloaded and comes back on it. Sent as a navigation like
 * every other action here, so this file still knows nothing about Tauri — but unlike the others this one is
 * refused when it arrives from anywhere except the app's own window, because what it does is end the process
 * and run an installer (setup_link.rs). */
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

/* The setup handoff. There is deliberately no `mode` on this link: the app runs the same connect script the
 * copy-paste command runs, and the script learns the reachability target by redeeming the code, so a link
 * that also named the mode would be a second, driftable copy of a decision the platform already made.
 *
 * The Cloudflare token rides the link ONLY inside the desktop webview, where the navigation is cancelled
 * in-process and never reaches the OS. An external browser's deep link can be logged by the protocol handler,
 * so from there it is omitted and the own-Cloudflare path stays on the pasted command. */
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

/* Ask the app to sign in, which it does in the user's DEFAULT BROWSER, because Google refuses OAuth from an
 * embedded webview and Google Identity Services is FedCM-based, which WebKitGTK does not implement. So the
 * login screen inside the app offers this instead of the in-page button that cannot work there; the
 * credentials come back over `intentic://auth` and the app reopens this SPA at /desktop-auth/complete. */
export const DESKTOP_SIGN_IN_LINK = `intentic://signin`;

export interface DesktopSyncArgs {
    /// The sandbox's own URL and the single-use pairing token — the same two values the card's one-liner
    /// carries as SANDBOX_URL and PAIR_TOKEN.
    url: string;
    pair: string;
    /// The sandbox's display name, so the app's screen can say what the folder is being connected to.
    name?: string;
    takeover?: boolean;
    /// A ports-only pairing: the app skips the folder dialog, because there is no folder.
    mirror?: boolean;
}

/* The desktop-sync handoff: the Desktop sync card's enrollment as a button instead of a pasted one-liner,
 * for the one computer where the app IS a process on the machine. Deliberately NO folder on the link — the
 * app collects that in a system dialog, which is the entire reason the handoff exists.
 *
 * The Rust side honours this from the app's own window ONLY (setup_link.rs): both values are the sender's,
 * and honoured from the OS handler any page could put its reader one folder pick away from two-way syncing
 * that folder into a sandbox the sender signs in to. A browser without the app keeps the one-liner. */
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

/* Swap a sandbox onto a different image: no hash updates to the fresh `:stable` base, a hash builds the
 * owner-approved overlay pinned to that digest, and `rollback` returns it to the image before the last update.
 * The same three argument shapes the pasted command carries.
 *
 * A rollback sends no digest even if one is at hand: it names a different destination image, and the app drops
 * the pair the same way rather than resolving it into a rebuild nobody asked for. */
export const desktopRecreateLink = (slug: string, hash?: string, rollback = false): string => {
    const params = new URLSearchParams({ slug });
    if (rollback) {
        params.set(`rollback`, `1`);
    } else if (hash !== undefined && hash !== ``) {
        params.set(`hash`, hash);
    }
    return `intentic://recreate?${params.toString()}`;
};

// Follow a handoff link. A navigation rather than a fetch, because that is what the app intercepts, and in a
// browser with no app installed it is a no-op the user cannot tell from a slow click, which is why every
// caller shows the download links beside it.
export const openDesktopLink = (link: string): void => {
    globalThis.location.href = link;
};

/* EVERY SIGN-IN SURFACE IN THIS APP ENDS UP HERE, which is the point of it being a function rather than the
 * one line it wraps. There are three of them, the login screen, the workspace's sandbox gate, and the
 * hand-off page itself, and each grew its own answer to "this webview cannot ask Google". Two got it right
 * and one rendered Google's button, which appears, takes clicks, and does nothing: the exact shape of a
 * broken product, on the screen between a fresh install and a working workspace.
 *
 * The mechanism enforces the rule now, useGoogleIdentity.renderButton refuses in this posture rather than
 * trusting three callers to each remember, and this is what a surface reaches for once it has been refused. */
export const signInThroughBrowser = (): void => openDesktopLink(DESKTOP_SIGN_IN_LINK);

/* Download links, chosen by build like scriptCommand.ts:
 *   • deploy (production): the intentic.dev vanity URLs, the site worker serves a locally-staged installer
 *     when one exists in its assets, else redirects to the newest release's asset.
 *   • local dev: the site's own dev server (`pnpm --filter @intentic/site dev`, port 4321), which serves
 *     _site/site/public/ at the root, stage installers into public/desktop/ with
 *     `pnpm --filter @intentic/desktop-app stage:downloads`, so the download is your own build.
 * The file names here are the STAGED ones, which is why they carry no version: a release artifact is named
 * Intentic-<version>-x64-setup.exe, but a working-tree build has no version to state (it carries the 0.0.0
 * "not a release" sentinel), and the dev server has no worker to resolve a name it was not given. */
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

/* THE ONE INSTALLER THIS BROWSER'S MACHINE CAN ACTUALLY RUN, or undefined where none of them can.
 *
 * Setup asks this to decide which of the two ways onto your own computer leads, an installer, or a pasted
 * `curl … | sudo sh`. A grid of every build we ship cannot answer that: it is a download page, and a reader
 * who is on the fence about a terminal is not helped by being asked which package format they want. So the
 * question here is narrower than DESKTOP_DOWNLOADS', and it is allowed to answer "none": macOS has no build
 * yet, and a button pointing at nothing is worse than the command it would displace.
 *
 * `userAgentData.platform` where the browser has it, `navigator.platform` otherwise, the same pair
 * useOsPreference reads, and the same `startsWith` rather than a /win/ match, since "Darwin" contains "win".
 * Android is excluded by hand: it reports "Linux armv8l" through both, and the AppImage is not for it. */
export const desktopInstaller = (): { platform: "windows" | "linux"; label: string; href: string } | undefined => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    if (/android/i.test(nav.userAgent)) {
        return undefined;
    }
    const platform = (nav.userAgentData?.platform ?? nav.platform ?? ``).toLowerCase();
    if (platform.startsWith(`win`)) {
        return { platform: `windows`, label: `Windows`, href: DESKTOP_DOWNLOADS.windows };
    }
    // The AppImage, because it runs across distributions without making this the moment somebody picks a
    // package format. Deb and rpm stay on the downloads page for the reader who wants one.
    if (platform.includes(`linux`)) {
        return { platform: `linux`, label: `Linux`, href: DESKTOP_DOWNLOADS.linuxAppImage };
    }
    return undefined;
};
