import { SANDBOX_RECOVERY_DAYS } from "@intentic/api-contract";
import { daysLeft, trashSection } from "./trashWindow";

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

describe(`trashSection`, () => {
    const base = { rows: 0, read: true, readError: false, asked: false };

    it(`draws the rows whenever something can come back, asked or not`, () => {
        expect(trashSection({ ...base, rows: 2 })).toBe(`rows`);
        expect(trashSection({ ...base, rows: 1, asked: true })).toBe(`rows`);
    });

    it(`leaves an empty, unread or unreadable trash off the board unless the reader came for it`, () => {
        expect(trashSection(base)).toBe(`hidden`);
        expect(trashSection({ ...base, read: false })).toBe(`hidden`);
        expect(trashSection({ ...base, read: false, readError: true })).toBe(`hidden`);
    });

    it(`answers a reader who came for it, whatever the trash holds`, () => {
        expect(trashSection({ ...base, asked: true })).toBe(`empty`);
        expect(trashSection({ ...base, read: false, asked: true })).toBe(`reading`);
        expect(trashSection({ ...base, read: false, readError: true, asked: true })).toBe(`error`);
    });
});
