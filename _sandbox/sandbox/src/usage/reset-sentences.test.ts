import { localZone, UTC, type Zone } from "@intentic/sandbox-contract/time/zone";
import { latestOf, namedPeriod, namedReset } from "./reset-sentences.js";

/* A loop hands a spent allowance over with its own retry instant, which is when it would ask again, not when the plan
   reopens. These are the vendors' own sentences from turns that were booked at the loop's instant instead (2026-10-17). */

// The afternoon the Codex refusal came, on the container's UTC clock, which the vendor's loop reads too.
const NOW = Date.UTC(2026, 9, 17, 13, 11, 15);
const at = (seconds: number): number => Math.ceil(NOW / 1000 + seconds);

// A wall clock is read on the zone the loop wrote it on, named per case, so no runner's own zone decides these.
const UTC_CLOCK = UTC;
// SAFETY: Europe/Warsaw is an IANA id ICU knows (time/zone.test.ts isZone), which is all a Zone promises.
const WARSAW = "Europe/Warsaw" as Zone;

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
    expect(namedReset(codex, NOW, UTC_CLOCK)).toBe(Date.UTC(2026, 9, 17, 17, 46) / 1000);
    // Already past today: tomorrow.
    expect(namedReset(`try again at 9:05 AM`, NOW, UTC_CLOCK)).toBe(Date.UTC(2026, 9, 18, 9, 5) / 1000);
    expect(namedReset(`try again at 17:46`, NOW, UTC_CLOCK)).toBe(Date.UTC(2026, 9, 17, 17, 46) / 1000);
});

// Codex prints in its own process's zone, which is this one's: a container started with TZ set reads 5:46 PM local.
test("reads a time of day on the loop's own wall clock, which is this process's unless named", () => {
    const codex = `You’ve hit your usage limit. To get more access now, send a request to your admin or try again at 5:46 PM.`;
    // 13:11 UTC is 15:11 in Warsaw (CEST, two hours ahead): 5:46 PM there is 15:46 UTC.
    expect(namedReset(codex, NOW, WARSAW)).toBe(Date.UTC(2026, 9, 17, 15, 46) / 1000);
    expect(namedReset(codex, NOW)).toBe(namedReset(codex, NOW, localZone()));
});

// 2026-10-15: Codex's wording for a reset on another day was read by nothing, so a team credit back at 00:54 stood a week.
test("reads a dated wall clock, Codex's wording for a reset on another day", () => {
    const said = Date.parse("2026-10-15T21:29:39.582Z");
    const codex = `You’ve hit your usage limit. To get more access now, send a request to your admin or try again at Oct 16th, 2026 12:54 AM.`;
    expect(namedReset(codex, said, UTC_CLOCK)).toBe(Date.parse("2026-10-16T00:54:00Z") / 1000);
    expect(namedReset(codex, said, WARSAW)).toBe(Date.parse("2026-10-15T22:54:00Z") / 1000);
    expect(namedReset(`try again at Oct 10th, 2026 2:28 AM.`, Date.parse("2026-10-09T23:26:31Z"), UTC_CLOCK)).toBe(Date.parse("2026-10-10T02:28:00Z") / 1000);
    // No year: this one's.
    expect(namedReset(`try again at Oct 18 9:00 AM`, NOW, UTC_CLOCK)).toBe(Date.parse("2026-10-18T09:00:00Z") / 1000);
    // A day no calendar holds is a misread, not the 1st of November.
    expect(namedReset(`try again at Oct 32nd, 2026 9:00 AM`, NOW, UTC_CLOCK)).toBeUndefined();
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
