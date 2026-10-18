import { latestOf, namedPeriod, namedReset } from "./reset-sentences.js";

/* A loop hands a spent allowance over with its own retry instant, which is when it would ask again, not when the plan
   reopens. These are the vendors' own sentences from turns that were booked at the loop's instant instead (2026-10-17). */

// The afternoon the Codex refusal came, on the container's UTC clock, which the vendor's loop reads too.
const NOW = Date.UTC(2026, 9, 17, 13, 11, 15);
const at = (seconds: number): number => Math.ceil(NOW / 1000 + seconds);

test("reads Google's countdown, whatever OpenCode's capped retry said", () => {
    const said = `Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 166h40m39s.`;
    expect(namedReset(said, NOW)).toBe(at(166 * 3_600 + 40 * 60 + 39));
});

test("reads a countdown written in words", () => {
    expect(namedReset(`Your limit resets in 2 hours 5 minutes.`, NOW)).toBe(at(2 * 3_600 + 5 * 60));
    expect(namedReset(`Weekly limit reached · resets in 3d`, NOW)).toBe(at(3 * 86_400));
});

test("reads a time of day as the next time the container's UTC clock shows it", () => {
    const codex = `You’ve hit your usage limit. To get more access now, send a request to your admin or try again at 5:46 PM.`;
    expect(namedReset(codex, NOW)).toBe(Date.UTC(2026, 9, 17, 17, 46) / 1000);
    // Already past today: tomorrow.
    expect(namedReset(`try again at 9:05 AM`, NOW)).toBe(Date.UTC(2026, 9, 18, 9, 5) / 1000);
    expect(namedReset(`try again at 17:46`, NOW)).toBe(Date.UTC(2026, 9, 17, 17, 46) / 1000);
});

test("reads an instant written out whole, and a body's own seconds", () => {
    expect(namedReset(`Quota resets at 2026-10-17T20:00:00Z.`, NOW)).toBe(Date.parse(`2026-10-17T20:00:00Z`) / 1000);
    expect(namedReset(`{"error":{"type":"model_cooldown","reset_seconds":1800}}`, NOW)).toBe(at(1_800));
});

test("names nothing where the sentence names no instant, or one that cannot be meant", () => {
    expect(namedReset(`You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.`, NOW)).toBeUndefined();
    expect(namedReset(`Please try again at 9.`, NOW)).toBeUndefined();
    expect(namedReset(`Resets in 900h.`, NOW)).toBeUndefined();
    expect(namedReset(`Quota resets at 2020-01-01T00:00:00Z.`, NOW)).toBeUndefined();
    // A unit is a whole word: "month" is no "m", which read it as a minute and booked a re-run sixty seconds out.
    expect(namedReset(`Your plan resets in 1 month.`, NOW)).toBeUndefined();
    expect(namedReset(`Resets in 2 mos.`, NOW)).toBeUndefined();
});

test("names the pool a sentence says ran out by its length", () => {
    expect(namedPeriod(`You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.`)).toBe(5 * 3_600);
    expect(namedPeriod(`You have hit your weekly limit.`)).toBe(7 * 86_400);
    expect(namedPeriod(`You're out of usage.`)).toBeUndefined();
});

test("the latest instant wins, and nothing named is nothing", () => {
    expect(latestOf(5, undefined, 9, 7)).toBe(9);
    expect(latestOf(undefined, undefined)).toBeUndefined();
});
