import type { SchemeChoice } from "@intentic/ui";
import type { Skin, SkinChoice } from "../../skins/useSkin";

// ONE ROW OVER TWO STORED CHOICES. The app's look is a scheme (`system`/`light`/`dark`) and a skin
// (`system`/`none`/`sanctum`), but two controls could show a light scheme under a dark skin with no way back, so
// Appearance offers four looks and this module is the map between them. Kept out of the SFC because the mapping has
// a side the row cannot show: pairs nobody picked here — a scheme pinned from the design kit, a profile link, a
// value already in storage — still have to name a look, and naming the wrong one is invisible until someone reads
// the row against the screen.

/** The four looks the Theme row offers. */
export type ThemeRow = "system" | "light" | "dark" | "sanctum";

/** The pair of preferences one look is made of. */
export interface ThemeLook {
    readonly scheme: SchemeChoice;
    readonly skin: SkinChoice;
}

export const THEME_ROW: readonly ThemeRow[] = [`system`, `light`, `dark`, `sanctum`];

/**
 * Which look the row should show, given both stored choices and the skin they resolve to. `system` is the pair
 * left unpinned, and is read first because it is the only state in which either half can still move on its own.
 * Below it the row names what is actually WORN: a dark scheme with the skin left to follow is the app in sanctum,
 * however that pair was arrived at.
 */
export const themeRowValue = (scheme: SchemeChoice, skinChoice: SkinChoice, skin: Skin): ThemeRow => {
    if (scheme === `system` && skinChoice === `system`) {
        return `system`;
    }
    if (skin === `sanctum`) {
        return `sanctum`;
    }
    return scheme === `system` ? `system` : scheme;
};

/** What pressing a look stores. Every press names BOTH halves, so no press can leave one of them following. */
export const themeRowLook = (row: ThemeRow): ThemeLook => {
    switch (row) {
        case `system`:
            return { scheme: `system`, skin: `system` };
        // Sanctum is built on a near-black canvas PrimeVue keys off, so choosing it is choosing dark as well.
        case `sanctum`:
            return { scheme: `dark`, skin: `sanctum` };
        default:
            return { scheme: row, skin: `none` };
    }
};
