import { describe, expect, it } from "vitest";
import { SANDBOX_RECOVERY_DAYS } from "@intentic/api-contract";
import { daysLeft } from "./trashWindow";

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
