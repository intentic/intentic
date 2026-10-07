import type { LocalPlace } from "../app/environments/localHost";
import { nameOf, openedAtMs, otherPlaces, PLACES_SHOWN, whereOf } from "./places";

describe(`when the app says a place was opened`, () => {
    const instant = Date.UTC(2026, 8, 28, 10, 0, 0);

    it(`reads state.rs's Unix seconds, milliseconds, a numeral and an ISO instant as the same moment`, () => {
        expect([openedAtMs(instant / 1000), openedAtMs(instant), openedAtMs(String(instant / 1000)), openedAtMs(`2026-09-28T10:00:00Z`)]).toEqual([
            instant,
            instant,
            instant,
            instant,
        ]);
    });

    it(`takes a number under 1e11 for seconds and one from there on for milliseconds`, () => {
        expect(openedAtMs(1e11 - 1)).toBe((1e11 - 1) * 1000);
        expect(openedAtMs(1e11)).toBe(1e11);
    });

    it(`says nothing of a time it cannot place, rather than 1970`, () => {
        expect(openedAtMs(0)).toBeUndefined();
        expect(openedAtMs(``)).toBeUndefined();
        expect(openedAtMs(`last week`)).toBeUndefined();
        expect(openedAtMs(Number.NaN)).toBeUndefined();
    });
});

describe(`a place's name, and the folder it is in`, () => {
    it.each([
        [`/home/ada/Taxes 2026`, `Taxes 2026`, `/home/ada`],
        [`/home/ada/Taxes 2026/`, `Taxes 2026`, `/home/ada`],
        [`/notes.md`, `notes.md`, `/`],
        [`/`, `/`, ``],
        [`C:\\Users\\ada\\Report Q3.docx`, `Report Q3.docx`, `C:\\Users\\ada`],
        [`C:\\notes.md`, `notes.md`, `C:\\`],
        [`E:\\`, `E:`, ``],
        [`\\\\nas\\share\\plans`, `plans`, `\\\\nas\\share`],
    ])(`%s is %s, in %s`, (path, name, where) => {
        expect([nameOf(path), whereOf(path)]).toEqual([name, where]);
    });
});

describe(`the recents the folder menu lists`, () => {
    const place = (path: string, folder = true): LocalPlace => ({ path, folder, openedAt: 1_790_000_000, exists: true, sandbox: false });

    it(`leaves out the folder this window shows, however its path is spelled`, () => {
        const places = [place(`C:\\Users\\ada\\intentic\\local`), place(`C:\\Users\\ada\\Taxes`), place(`C:\\Users\\ada\\Notes`)];
        expect(otherPlaces(places, `C:/Users/ada/intentic/local/`).map((kept) => kept.path)).toEqual([
            `C:\\Users\\ada\\Taxes`,
            `C:\\Users\\ada\\Notes`,
        ]);
        // A folder of the same name elsewhere is another place.
        expect(otherPlaces([place(`/home/ada/local`)], `/home/ada/intentic/local`).map((kept) => kept.path)).toEqual([`/home/ada/local`]);
    });

    it(`lists folders only: a document opened on its own is the app's recent, never a place the menu offers`, () => {
        const places = [place(`/home/ada/Taxes/q3.xlsx`, false), place(`/home/ada/Taxes`), place(`/home/ada/notes.md`, false)];
        expect(otherPlaces(places, undefined).map((kept) => kept.path)).toEqual([`/home/ada/Taxes`]);
    });

    it(`keeps every one, in order, for a window that shows no folder yet, and no more than the app keeps`, () => {
        const many = Array.from({ length: PLACES_SHOWN + 1 }, (_, index) => place(`/home/ada/project-${index + 1}`));
        expect(PLACES_SHOWN).toBe(12);
        expect(otherPlaces(many, undefined)).toEqual(many.slice(0, 12));
    });
});
