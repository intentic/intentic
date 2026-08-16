/* The desktop builds, named once.
 *
 * Two places hand out an installer and they must agree: the download page, which lays every build out side by
 * side, and the hero's button, which picks the one build that matches the visitor's computer. The hrefs are
 * the site worker's vanity paths (worker.ts) rather than release assets, so nothing here needs a bump when a
 * version ships. The glyph rides along because a button that says Windows and draws a penguin is worse than
 * one that draws nothing.
 *
 * macOS is deliberately absent: there is no build, so the hero falls back to the download page, which says so
 * in words and points at the one-line install that does work on a Mac. */

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

/** A tray with an arrow into it. The neutral stand-in, shown until a platform is recognised. */
export const DESKTOP_GENERIC_ICON =
    "M12 2a1 1 0 0 1 1 1v9.586l3.293-3.293a1 1 0 1 1 1.414 1.414l-5 5a1 1 0 0 1-1.414 0l-5-5a1 1 0 1 1 1.414-1.414L11 12.586V3a1 1 0 0 1 1-1zM4 19a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1z";
