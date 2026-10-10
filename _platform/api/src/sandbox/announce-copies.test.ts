import { announcedCopyOf, type CopiesState, duplicateCopiesOf, noteAnnounce } from "./announce-copies.js";

// Which copies of a sandbox are announcing (announce-copies.ts): the rule that tells two containers on one token from one
// container that restarted, played as the announces a real fleet sends.

const MINUTE = 60_000;
const START = Date.parse(`2026-10-05T12:00:00Z`);
const at = (minutes: number): Date => new Date(START + minutes * MINUTE);

// Plays a list of [minute, instance, host, os] announces from an empty row, answering the state after each.
const play = (announces: readonly (readonly [number, string, string?, string?])[]): CopiesState[] => {
    let state: CopiesState = { seen: [], duplicateSince: null };
    return announces.map(([minute, instance, host, os]) => {
        state = noteAnnounce(state, { instance, ...(host === undefined ? {} : { host }), ...(os === undefined ? {} : { os }) }, at(minute));
        return state;
    });
};

describe(`noteAnnounce`, () => {
    it(`never calls a restart two copies: the new instance starts after the old one's last announce`, () => {
        const states = play([
            [0, `a`],
            [60, `a`],
            [120, `a`],
            [122, `b`],
            [182, `b`],
            [242, `b`],
        ]);
        expect(states.every((state) => state.duplicateSince === null)).toBe(true);
    });

    // A cutover whose old container says goodbye once more as it stops: a minute of overlap, not a second copy.
    it(`does not read the tail of a cutover as a second copy`, () => {
        const states = play([
            [0, `old`],
            [120, `new`],
            [121, `old`],
            [180, `new`],
            [240, `new`],
        ]);
        expect(states.every((state) => state.duplicateSince === null)).toBe(true);
    });

    // Two copies whose hourly heartbeats fall at different minutes: forty-five minutes apart, every hour.
    it(`names two copies that keep announcing side by side, within about an hour of the second starting`, () => {
        const states = play([
            [0, `pwsh`, `ROG`, `windows`],
            [45, `wsl`, `rog`, `linux`],
            [60, `pwsh`],
            [105, `wsl`],
        ]);
        expect(states.map((state) => state.duplicateSince?.getTime() ?? null)).toEqual([null, null, null, at(105).getTime()]);
        // What each copy said of itself is kept, whichever announce last carried it.
        expect(states[3]?.seen.map((copy) => [copy.instance, copy.host, copy.os])).toEqual([
            [`wsl`, `rog`, `linux`],
            [`pwsh`, `ROG`, `windows`],
        ]);
    });

    it(`keeps the moment it first saw them side by side, and clears it once one copy has been alone an hour`, () => {
        const states = play([
            [0, `a`],
            [5, `b`],
            [60, `a`],
            [65, `b`],
            [120, `a`],
            // b stopped after 65: a's next announces are alone, the first one past an hour of b's silence clears it.
            [125, `a`],
            [180, `a`],
        ]);
        expect(states[3]?.duplicateSince?.getTime()).toBe(at(65).getTime());
        expect(states[4]?.duplicateSince?.getTime()).toBe(at(65).getTime());
        expect(states[5]?.duplicateSince?.getTime()).toBe(at(65).getTime());
        expect(states[6]?.duplicateSince).toBeNull();
    });

    it(`keeps two copies at most: a third pushes out the one silent longest`, () => {
        const states = play([
            [0, `a`],
            [10, `b`],
            [20, `c`],
        ]);
        expect(states[2]?.seen.map((copy) => copy.instance)).toEqual([`c`, `b`]);
    });
});

describe(`announcedCopyOf`, () => {
    it(`reads nothing from a daemon too old to name its instance`, () => {
        expect(announcedCopyOf({ host: `rog` })).toBeUndefined();
        expect(announcedCopyOf(undefined)).toBeUndefined();
    });

    it(`drops a label that is not one, rather than refusing the announce`, () => {
        expect(announcedCopyOf({ instance: ` i1 `, host: `x`.repeat(500), os: 7 })).toEqual({ instance: `i1` });
        expect(announcedCopyOf({ instance: `i1`, host: `rog`, os: `linux` })).toEqual({ instance: `i1`, host: `rog`, os: `linux` });
    });

    it(`reads the engine a copy runs on, and keeps it on the copy`, () => {
        const copy = announcedCopyOf({ instance: `i1`, host: `omen`, os: `windows`, engine: `intentic` });
        expect(copy).toEqual({ instance: `i1`, host: `omen`, os: `windows`, engine: `intentic` });
        expect(announcedCopyOf({ instance: `i1`, engine: `x`.repeat(41) })).toEqual({ instance: `i1` });
    });
});

describe(`duplicateCopiesOf`, () => {
    const seen = [
        { instance: `wsl`, host: `rog`, os: `linux`, firstAt: at(45).toISOString(), at: at(105).toISOString() },
        { instance: `pwsh`, host: `ROG`, os: `windows`, firstAt: at(0).toISOString(), at: at(60).toISOString() },
    ];

    it(`names both copies, and since when, while either still announces`, () => {
        expect(duplicateCopiesOf(seen, at(105), at(110))).toEqual({ hosts: [`rog (linux)`, `ROG (windows)`], since: at(105).toISOString() });
    });

    it(`says nothing once both copies have gone quiet, or when one copy announces alone`, () => {
        expect(duplicateCopiesOf(seen, at(105), at(105 + 4 * 60))).toBeNull();
        expect(duplicateCopiesOf(seen, null, at(110))).toBeNull();
        expect(duplicateCopiesOf(`not a list`, at(105), at(110))).toBeNull();
    });
});
