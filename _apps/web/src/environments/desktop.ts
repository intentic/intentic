import { environment } from "./environment";

/* THE DESKTOP APP, AS THE BROWSER SEES IT (_apps/desktop).
 *
 * The app's workspace window loads this very SPA and marks itself with `__INTENTIC_DESKTOP__`, injected by a
 * Tauri initialization script. Everything this module builds is an `intentic://` LINK, never IPC: the app
 * intercepts those navigations in Rust, so remote content gets no command surface at all — and the identical
 * link works from an external browser, where the OS routes it to the installed app. Nothing here imports
 * Tauri, and nothing here is desktop-only at runtime; a plain browser just gets links nobody handles.
 *
 * Which is also why this file is about THREE cards rather than one. The app replaces a terminal in three
 * places, and only the first is onboarding:
 *   • Setup step 3 — "run this install command on the machine" → Run on this computer
 *   • the Update card — the sandbox holds no host Docker socket, so it can NEVER recreate its own container
 *   • the Environment card — the same, for an owner-approved overlay
 * The last two are the ones a user meets over and over, which is the real argument for the app existing. */

declare global {
    interface Window {
        __INTENTIC_DESKTOP__?: { version: string };
    }
}

export const desktopVersion = (): string | undefined => window.__INTENTIC_DESKTOP__?.version;

export interface DesktopSetupArgs {
    code: string;
    name?: string;
    cfToken?: string;
    syncDir?: string;
    platformUrl?: string;
}

/* The setup handoff. There is deliberately no `mode` on this link: the app runs the same connect script the
 * copy-paste command runs, and the script learns the reachability target by redeeming the code — so a link
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

/* Ask the app to sign in — which it does in the user's DEFAULT BROWSER, because Google refuses OAuth from an
 * embedded webview and Google Identity Services is FedCM-based, which WebKitGTK does not implement. So the
 * login screen inside the app offers this instead of the in-page button that cannot work there; the
 * credentials come back over `intentic://auth` and the app reopens this SPA at /desktop-auth/complete. */
export const DESKTOP_SIGN_IN_LINK = `intentic://signin`;

// Swap a sandbox onto a different image: no hash updates to the fresh `:stable` base, a hash builds the
// owner-approved overlay pinned to that digest. The same two argument shapes the pasted command carries.
export const desktopRecreateLink = (slug: string, hash?: string): string => {
    const params = new URLSearchParams({ slug });
    if (hash !== undefined && hash !== ``) {
        params.set(`hash`, hash);
    }
    return `intentic://recreate?${params.toString()}`;
};

// Follow a handoff link. A navigation rather than a fetch, because that is what the app intercepts — and in a
// browser with no app installed it is a no-op the user cannot tell from a slow click, which is why every
// caller shows the download links beside it.
export const openDesktopLink = (link: string): void => {
    globalThis.location.href = link;
};

/* Download links, chosen by build like scriptCommand.ts:
 *   • deploy (production): the intentic.dev vanity URLs — the site worker serves a locally-staged installer
 *     when one exists in its assets, else redirects to the newest release's asset.
 *   • local dev: the site's own dev server (`pnpm --filter @intentic-dev/site dev`, port 4321), which serves
 *     _apps/site/public/ at the root — stage installers into public/desktop/ with
 *     `pnpm --filter @intentic-app/desktop stage:downloads`, so the download is your own build.
 * File names are the release-stable ones from _tools/scripts/build-desktop.sh. */
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
