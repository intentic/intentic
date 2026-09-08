// Desktop builds, named once for the download page and the hero button so they agree. hrefs are the site worker vanity
// paths (worker.ts), not release assets, so a new version needs no changes here. No macOS build; the hero falls back to
// the download page, which points at the one-line install.

export interface DesktopPlatform {
    /** As a person would say it, and as the button reads: "Download for Windows". */
    name: string;
    /** The site worker's stable vanity path. Serves a locally-staged installer, else the newest release. */
    href: string;
    /** A single 24×24 fill path. */
    icon: string;
}

export const desktopPlatforms = {
    windows: {
        name: "Windows",
        href: "/desktop/windows",
        icon: "M0 3.449 9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801",
    },
    linux: {
        name: "Linux",
        href: "/desktop/linux",
        icon: "M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z",
    },
} as const satisfies Record<string, DesktopPlatform>;

/** Where the button points before it knows anything, and where a Mac or a phone keeps pointing. */
export const DESKTOP_DOWNLOADS_PAGE = "/download/";

/** Every asset this project has ever handed anybody, and the fallback when a named one cannot be resolved. */
export const RELEASES_URL = "https://github.com/intentic/intentic/releases";

export interface DesktopRoute {
    /** The plain name an installer carries when it is staged into public/desktop/ for a local download test. */
    staged: string;
    /** The release asset the path hands over, named for the version it came from. */
    asset: (version: string) => string;
}

// What each vanity path resolves to; the worker and the dev server (astro.config.mjs) both read this one table.
export const DESKTOP_ROUTES: Record<string, DesktopRoute> = {
    "/desktop": { staged: "Intentic-setup.exe", asset: (v) => `Intentic-${v}-x64-setup.exe` },
    "/desktop/windows": { staged: "Intentic-setup.exe", asset: (v) => `Intentic-${v}-x64-setup.exe` },
    "/desktop/linux": { staged: "Intentic.AppImage", asset: (v) => `Intentic-${v}-x86_64.AppImage` },
    "/desktop/deb": { staged: "Intentic.deb", asset: (v) => `Intentic-${v}-amd64.deb` },
    "/desktop/rpm": { staged: "Intentic.rpm", asset: (v) => `Intentic-${v}-x86_64.rpm` },
};

/** A tray with an arrow into it. The neutral stand-in, shown until a platform is recognised. */
export const DESKTOP_GENERIC_ICON =
    "M12 2a1 1 0 0 1 1 1v9.586l3.293-3.293a1 1 0 1 1 1.414 1.414l-5 5a1 1 0 0 1-1.414 0l-5-5a1 1 0 1 1 1.414-1.414L11 12.586V3a1 1 0 0 1 1-1zM4 19a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1z";
