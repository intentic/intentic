import { environment } from "./environment";

/* The desktop app (\_apps/desktop) marks its workspace webview by injecting `__INTENTIC_DESKTOP__`
 * via a Tauri initialization script. The handoff channel is deliberately NOT IPC: the app's window
 * intercepts `intentic://` navigations in Rust, so the same link works from the in-app webview AND
 * from any external browser where the app is installed (OS deep link). Nothing here imports Tauri. */

declare global {
    interface Window {
        __INTENTIC_DESKTOP__?: { version: string };
    }
}

export interface DesktopSetupArgs {
    code: string;
    mode: `intentic` | `own` | `local`;
    name?: string;
    cfToken?: string;
    syncDir?: string;
    platformUrl?: string;
}

export const desktopVersion = (): string | undefined => window.__INTENTIC_DESKTOP__?.version;

// The Cloudflare token rides the link ONLY inside the desktop webview, where the navigation is
// intercepted in-process and never reaches the OS (an external browser's deep link may be logged
// by the protocol handler, so there we omit it and the app asks for the token natively).
export const desktopSetupLink = (args: DesktopSetupArgs): string => {
    const params = new URLSearchParams({ code: args.code, mode: args.mode });
    if (args.name !== undefined && args.name !== ``) {
        params.set(`name`, args.name);
    }
    if (args.cfToken !== undefined && desktopVersion() !== undefined) {
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

/* Download links, chosen by build like scriptCommand.ts:
 *   • deploy (production): the intentic.dev vanity URLs — the site worker serves a locally-staged
 *     installer when one exists in its assets, else redirects to the latest release's asset.
 *   • local dev: the site's own dev server (`pnpm --filter @intentic-dev/site dev`, port 4321),
 *     which serves _apps/site/public/ at the root — stage installers into public/desktop/ with
 *     `pnpm --filter @intentic-app/desktop stage:downloads`, so the download is your local build.
 * File names are the release-stable ones from _apps/desktop/scripts/release-build.sh. */
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
