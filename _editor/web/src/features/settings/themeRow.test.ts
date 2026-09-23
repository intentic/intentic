import type { SchemeChoice } from "@intentic/ui";
import type { Skin, SkinChoice } from "../../skins/useSkin";
import { THEME_ROW, type ThemeRow, themeRowLook, themeRowValue } from "./themeRow";

// The Theme row is one control over two preferences, so the mapping has to answer for pairs the row cannot make:
// a scheme pinned from the design kit, a profile link, a value already in storage. The bug this pins is that one
// of them — a dark scheme with the skin left following — wore sanctum while the row read "Dark".

/** useSkin's own rule, so the cases below name the pair and the resolved skin comes out of one place. */
const resolve = (scheme: SchemeChoice, skin: SkinChoice, os: "light" | "dark"): Skin => {
    if (skin !== `system`) {
        return skin;
    }
    return (scheme === `system` ? os : scheme) === `dark` ? `sanctum` : `none`;
};

const rowFor = (scheme: SchemeChoice, skin: SkinChoice, os: "light" | "dark" = `light`): ThemeRow =>
    themeRowValue(scheme, skin, resolve(scheme, skin, os));

describe(`what the row shows`, () => {
    it(`reads System only while BOTH halves are still the system's to move`, () => {
        expect(rowFor(`system`, `system`, `light`)).toBe(`system`);
        expect(rowFor(`system`, `system`, `dark`)).toBe(`system`);
    });

    it(`names what is worn when a scheme was pinned and the skin left to follow`, () => {
        expect(rowFor(`dark`, `system`)).toBe(`sanctum`);
        expect(rowFor(`light`, `system`)).toBe(`light`);
    });

    it(`reads each pinned pair back as the look that made it`, () => {
        expect(rowFor(`light`, `none`)).toBe(`light`);
        expect(rowFor(`dark`, `none`)).toBe(`dark`);
        expect(rowFor(`dark`, `sanctum`)).toBe(`sanctum`);
    });
});

describe(`what a press stores`, () => {
    it(`names both halves every time, so no press leaves one following`, () => {
        for (const row of THEME_ROW) {
            const look = themeRowLook(row);
            expect([look.scheme, look.skin]).not.toContain(undefined);
        }
    });

    it(`takes sanctum's scheme with it, since sanctum has no daylight dress`, () => {
        expect(themeRowLook(`sanctum`)).toEqual({ scheme: `dark`, skin: `sanctum` });
    });

    it(`hands both halves back to the OS for System`, () => {
        expect(themeRowLook(`system`)).toEqual({ scheme: `system`, skin: `system` });
    });

    // The round trip is the whole contract: press a look, and the row must still read that look afterwards.
    it(`reads back every look it can store, under either OS`, () => {
        for (const row of THEME_ROW) {
            const { scheme, skin } = themeRowLook(row);
            expect(rowFor(scheme, skin, `light`)).toBe(row);
            expect(rowFor(scheme, skin, `dark`)).toBe(row);
        }
    });
});
