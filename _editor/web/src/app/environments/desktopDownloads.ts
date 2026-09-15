import { environment } from "./environment";

// Where to get the desktop app, chosen by build (like scriptCommand.ts): deploy serves the intentic.dev vanity URLs
// (site worker resolves to the newest release or a staged installer); dev serves the site's own dev server, staged
// via `pnpm --filter @intentic/desktop-app stage:downloads`. Apart from desktop.ts, which is about the app the page
// is already inside and must load where no deploy config exists (a node test, a floating window's module graph).

// File names here are the staged ones, unversioned, since a working-tree build has no release version to state.
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
