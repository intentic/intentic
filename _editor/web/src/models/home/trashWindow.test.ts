import { SANDBOX_RECOVERY_DAYS, type TrashedSandbox } from "@intentic/api-contract";
import { daysLeft, trashLanes, trashState } from "./trashWindow";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);
const at = (ms: number): string => new Date(NOW + ms).toISOString();

describe(`daysLeft`, () => {
    it(`counts the whole window the moment a sandbox is deleted`, () => {
        expect(daysLeft(at(SANDBOX_RECOVERY_DAYS * DAY_MS), NOW)).toBe(SANDBOX_RECOVERY_DAYS);
    });

    it(`rounds up, so a row with hours left never reads as having none`, () => {
        // An hour short of a day is still a day the owner can act in; "0 days left" beside a working button is a lie.
        expect(daysLeft(at(DAY_MS - 60 * 60 * 1000), NOW)).toBe(1);
        expect(daysLeft(at(1), NOW)).toBe(1);
        expect(daysLeft(at(DAY_MS + 1), NOW)).toBe(2);
    });

    it(`floors at zero once the window has passed, rather than counting backwards`, () => {
        expect(daysLeft(at(0), NOW)).toBe(0);
        expect(daysLeft(at(-5 * DAY_MS), NOW)).toBe(0);
    });
});

describe(`trashState`, () => {
    const base = { rows: 0, read: true, readError: false };

    it(`draws the rows whenever something can come back, even when a later read failed`, () => {
        expect(trashState({ ...base, rows: 2 })).toBe(`rows`);
        expect(trashState({ ...base, rows: 1, readError: true })).toBe(`rows`);
    });

    it(`tells an empty trash from one not read yet and one that could not be read`, () => {
        expect(trashState(base)).toBe(`empty`);
        expect(trashState({ ...base, read: false })).toBe(`reading`);
        expect(trashState({ ...base, read: false, readError: true })).toBe(`error`);
    });
});

describe(`trashLanes`, () => {
    const row = (id: string, hosted: boolean): TrashedSandbox => ({ id, name: id, image: null, deletedAt: at(0), purgeAfter: at(DAY_MS), hosted });

    it(`says each restore's promise once, over the rows it holds for, cloud first and in the order read`, () => {
        const lanes = trashLanes([row(`a`, false), row(`b`, true), row(`c`, false)]);
        expect(lanes.map(({ lane, rows }) => [lane, rows.map(({ id }) => id)])).toEqual([
            [`cloud`, [`b`]],
            [`own`, [`a`, `c`]],
        ]);
    });

    it(`draws no lane that holds nothing`, () => {
        expect(trashLanes([row(`a`, false)]).map(({ lane }) => lane)).toEqual([`own`]);
        expect(trashLanes([])).toEqual([]);
    });
});
