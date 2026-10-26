import type { SchemeChoice } from "@intentic/ui";
import type { Skin, SkinChoice } from "./useSkin";

// ONE ROW OVER TWO STORED CHOICES. The app's look is a scheme (`system`/`light`/`dark`) and a skin
// (`system`/`none`/`sanctum`/`silver`), but two controls could show a light scheme under a dark skin with no way back, so
// Appearance offers five looks and this module is the map between them. Kept out of the SFC because the mapping has
// a side the row cannot show: pairs nobody picked here — a scheme pinned from the design kit, a profile link, a
// value already in storage — still have to name a look, and naming the wrong one is invisible until someone reads
// the row against the screen.

/** The five looks the Theme row offers. */
export type ThemeRow = "system" | "light" | "dark" | "sanctum" | "silver";

/** The pair of preferences one look is made of. */
export interface ThemeLook {
    readonly scheme: SchemeChoice;
    readonly skin: SkinChoice;
}

export const THEME_ROW: readonly ThemeRow[] = [`system`, `light`, `dark`, `sanctum`, `silver`];

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
    if (skin === `sanctum` || skin === `silver`) {
        return skin;
    }
    return scheme === `system` ? `system` : scheme;
};

/** What pressing a look stores. Every press names BOTH halves, so no press can leave one of them following. */
export const themeRowLook = (row: ThemeRow): ThemeLook => {
    switch (row) {
        case `system`:
            return { scheme: `system`, skin: `system` };
        // Both skins are built on a dark canvas PrimeVue keys off, so choosing one is choosing dark as well.
        case `sanctum`:
        case `silver`:
            return { scheme: `dark`, skin: row };
        default:
            return { scheme: row, skin: `none` };
    }
};
