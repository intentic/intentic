import { type DeviceSigns, deviceShown, FILTER_AFTER, filterRecents, nameOf, openedAtMs, RECENTS_SHOWN, recentRows, recentWhen, whereOf } from "./home";

// Instants are built on the runner's own clock, as the reader's are, around a day in mid-July: no zone moves its
// clocks within a week of it, so a day here is 24 hours wherever this runs.
const at = (day: number, hour: number, minute = 0): number => new Date(2026, 6, day, hour, minute).getTime();
const NOW = at(15, 14, 30);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe(`how long ago a recent was opened`, () => {
    it(`says "just now" under a minute, and for a clock that has moved back since`, () => {
        expect(recentWhen(NOW, NOW)).toEqual({ kind: `justNow` });
        expect(recentWhen(NOW - MINUTE + 1, NOW)).toEqual({ kind: `justNow` });
        expect(recentWhen(NOW + 5 * MINUTE, NOW)).toEqual({ kind: `justNow` });
    });

    it(`counts whole minutes under an hour, rounded down`, () => {
        expect(recentWhen(NOW - MINUTE, NOW)).toEqual({ kind: `minutes`, count: 1 });
        expect(recentWhen(NOW - 5 * MINUTE - 59_000, NOW)).toEqual({ kind: `minutes`, count: 5 });
        expect(recentWhen(NOW - HOUR + 1, NOW)).toEqual({ kind: `minutes`, count: 59 });
    });

    it(`counts whole hours under a day, across midnight too`, () => {
        expect(recentWhen(NOW - HOUR, NOW)).toEqual({ kind: `hours`, count: 1 });
        expect(recentWhen(NOW - 24 * HOUR + 1, NOW)).toEqual({ kind: `hours`, count: 23 });
        // Half past midnight, looking back at eleven the evening before: an hour ago, which "yesterday" would hide.
        expect(recentWhen(at(14, 23), at(15, 0, 30))).toEqual({ kind: `hours`, count: 1 });
    });

    it(`says "yesterday" from a day back, and only for the calendar's yesterday`, () => {
        expect(recentWhen(NOW - 24 * HOUR, NOW)).toEqual({ kind: `yesterday` });
        expect(recentWhen(at(14, 0, 5), NOW)).toEqual({ kind: `yesterday` });
        // Twenty-five hours before half past midnight is the day before yesterday: a date, not "yesterday".
        expect(recentWhen(at(13, 23, 30), at(15, 0, 30))).toEqual({ kind: `date`, at: at(13, 23, 30), thisYear: true });
    });

    it(`gives the date past yesterday, and says whether its year is this one`, () => {
        expect(recentWhen(at(3, 9), NOW)).toEqual({ kind: `date`, at: at(3, 9), thisYear: true });
        const newYearsEve = new Date(2025, 11, 31, 18, 0).getTime();
        expect(recentWhen(newYearsEve, NOW)).toEqual({ kind: `date`, at: newYearsEve, thisYear: false });
    });
});

describe(`when the app says a recent was opened`, () => {
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

describe(`a recent's name, and the folder it is in`, () => {
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

describe(`filtering the recents`, () => {
    const RECENTS = [`/home/ada/Taxes 2026`, `/home/ada/Photos/Iceland`, `C:\\Users\\ada\\Documents\\Report Q3.docx`, `/srv/shared/taxes-archive`].map(
        (path) => ({ path }),
    );
    const pathsFor = (query: string): string[] => filterRecents(RECENTS, query).map((recent) => recent.path);

    it(`keeps every recent, in order, when there is nothing to look for`, () => {
        expect(filterRecents(RECENTS, `   `)).toEqual(RECENTS);
    });

    it(`finds a word in the name or in the folder, whatever its case`, () => {
        expect(pathsFor(`TAXES`)).toEqual([`/home/ada/Taxes 2026`, `/srv/shared/taxes-archive`]);
        expect(pathsFor(`photos`)).toEqual([`/home/ada/Photos/Iceland`]);
    });

    it(`needs every word, in any order`, () => {
        expect(pathsFor(`2026 taxes`)).toEqual([`/home/ada/Taxes 2026`]);
        expect(pathsFor(`taxes iceland`)).toEqual([]);
    });

    it(`reads either separator as the other`, () => {
        expect(pathsFor(`ada/documents`)).toEqual([`C:\\Users\\ada\\Documents\\Report Q3.docx`]);
        expect(pathsFor(`ada\\photos`)).toEqual([`/home/ada/Photos/Iceland`]);
    });
});

describe(`the rows Home lists`, () => {
    const many = (count: number): { path: string }[] => Array.from({ length: count }, (_, index) => ({ path: `/home/ada/project-${index + 1}` }));

    it(`offers the filter past six and lists no more than twelve`, () => {
        expect([RECENTS_SHOWN, FILTER_AFTER]).toEqual([12, 6]);
        expect(recentRows(many(6), ``)).toEqual({ rows: many(6), filterable: false });
        expect(recentRows(many(7), ``)).toEqual({ rows: many(7), filterable: true });
        expect(recentRows(many(13), ``)).toEqual({ rows: many(12), filterable: true });
    });

    it(`narrows only while the filter is on screen, and only what is listed`, () => {
        expect(recentRows(many(7), `project-7`).rows).toEqual([{ path: `/home/ada/project-7` }]);
        // Six rows draw no filter, so a query left over from a longer list must not hide any of them.
        expect(recentRows(many(6), `project-7`).rows).toEqual(many(6));
        // The thirteenth is past the list, so no query brings it back.
        expect(recentRows(many(13), `project-13`).rows).toEqual([]);
    });
});

describe(`whether Home shows this device`, () => {
    const NONE: DeviceSigns = { hostsSandboxes: false, sandboxes: 0, agent: false, inFlight: false };

    it(`stays out of the way on a machine that only opens files, whatever its Docker is doing`, () => {
        expect(deviceShown(NONE)).toBe(false);
    });

    it(`shows for any one sign that a sandbox lives here`, () => {
        expect([
            deviceShown({ ...NONE, hostsSandboxes: true }),
            deviceShown({ ...NONE, sandboxes: 1 }),
            deviceShown({ ...NONE, agent: true }),
            deviceShown({ ...NONE, inFlight: true }),
        ]).toEqual([true, true, true, true]);
    });
});
