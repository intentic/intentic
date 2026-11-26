import { APP_URL } from "@intentic/site-content/site";
import { desktopPlatforms } from "../../lib/desktop-downloads";
import { BRAND, glyph, mark, type GlyphName } from "./glyphs";

/* EVERY WAY TO INSTALL IT, for the picker beside the Download button. One row per file a person can end up with, each
   answering the two questions a reader brings to it: which file is this, and will it run on mine. Names and links come
   from the same table as the download page's tiles, so the picker and the tiles never point at different files. */

/** The Mac path is the one-line install, and that line carries a setup code only the setup screen can hand out. */
export const MACOS_SETUP_URL = `${APP_URL}/setup?machine=mine`;

let pickers = 0;
/** A fresh id for a picker's sheet: one page can carry two (the hero's and the closing band's). */
export const nextPickerId = (): string => `download-picker-${++pickers}`;

/** The systems the page can recognise. The row tagged with the reader's own is the file the main button hands over. */
export type DetectedSystem = "windows" | "linux" | "macos";

export interface DownloadChoice {
    /** What it runs on, as the row leads: "Windows". */
    system: string;
    /** What you get, after it in a quieter ink: ".exe", "Intentic OS". */
    get: string;
    /** Whether it runs on yours: the oldest release it needs, or its catch. */
    needs: string;
    href: string;
    /** The system's own mark where it has one, a line glyph where it does not. */
    icon: string;
    /** Lit as "This computer" when the reader is on this system. */
    here?: DetectedSystem;
    /** The same build in other packages, on a small line under the row rather than a row each. */
    also?: { label: string; href: string; on: string }[];
}

export interface DownloadGroup {
    /** Shown over the group; the first group is the obvious one and goes without. */
    label?: string;
    choices: DownloadChoice[];
}

// Sized by the picker's own styles, so a mark and a line glyph sit in one column at one size.
const brand = (path: string): string => mark(path, "");
const line = (name: GlyphName): string => glyph(name, "");

export const downloadGroups: DownloadGroup[] = [
    {
        choices: [
            {
                system: desktopPlatforms.windows.name,
                get: ".exe",
                needs: "10 and 11, 64-bit",
                href: desktopPlatforms.windows.href,
                icon: brand(desktopPlatforms.windows.icon),
                here: "windows",
            },
            // The packages share the AppImage's glibc floor, so its "needs" covers all three.
            {
                system: desktopPlatforms.linux.name,
                get: "AppImage",
                needs: "glibc 2.39+",
                href: desktopPlatforms.linux.href,
                icon: brand(desktopPlatforms.linux.icon),
                here: "linux",
                also: [
                    { label: ".deb", href: "/desktop/deb", on: "Ubuntu, Debian" },
                    { label: ".rpm", href: "/desktop/rpm", on: "Fedora, RHEL" },
                ],
            },
            {
                system: "macOS",
                get: "one-line install",
                needs: "No app yet",
                href: MACOS_SETUP_URL,
                icon: brand(BRAND.apple),
                here: "macos",
            },
            {
                system: "Spare PC",
                get: "Intentic OS",
                needs: "USB installer",
                href: "/os/",
                icon: line("host"),
            },
        ],
    },
    {
        label: "Phone and watch",
        choices: [
            { system: "Android phone", get: "Intentic Device", needs: "Android 8+", href: "/phone/", icon: brand(BRAND.android) },
            { system: "Wear OS watch", get: "Intentic Device", needs: "Wear OS 3+", href: "/watch/", icon: brand(BRAND.wearos) },
        ],
    },
];
