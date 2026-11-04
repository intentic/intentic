import { asZone, UTC } from "../time/zone.js";
import { NightHoursSchema, nightLength, withinNight } from "./night-hours.js";

// The window is read on a named clock, so every instant below is built in that zone's own terms.
const WARSAW = asZone("Europe/Warsaw")!;
const at = (iso: string): number => Date.parse(iso);

test("nothing is decided for anyone until the owner sets the hours: off by default", () => {
    expect(NightHoursSchema.parse({})).toEqual({ on: false, from: "23:00", to: "07:00", questions: "decide" });
});

test("a window that crosses midnight holds both sides of it, and not the day between", () => {
    const night = { from: "23:00", to: "07:00" };
    expect(withinNight(night, UTC, at("2026-11-04T23:00:00Z"))).toBe(true);
    expect(withinNight(night, UTC, at("2026-11-05T03:30:00Z"))).toBe(true);
    // `to` itself is morning already.
    expect(withinNight(night, UTC, at("2026-11-05T07:00:00Z"))).toBe(false);
    expect(withinNight(night, UTC, at("2026-11-04T22:59:00Z"))).toBe(false);
    expect(withinNight(night, UTC, at("2026-11-04T12:00:00Z"))).toBe(false);
});

test("a window inside one day, for someone who sleeps after midnight", () => {
    const night = { from: "01:30", to: "09:15" };
    expect(withinNight(night, UTC, at("2026-11-04T01:30:00Z"))).toBe(true);
    expect(withinNight(night, UTC, at("2026-11-04T09:14:00Z"))).toBe(true);
    expect(withinNight(night, UTC, at("2026-11-04T09:15:00Z"))).toBe(false);
    expect(withinNight(night, UTC, at("2026-11-04T00:00:00Z"))).toBe(false);
});

test("a window that begins where it ends is no night at all, not a whole day", () => {
    expect(withinNight({ from: "07:00", to: "07:00" }, UTC, at("2026-11-04T07:00:00Z"))).toBe(false);
    expect(withinNight({ from: "07:00", to: "07:00" }, UTC, at("2026-11-04T02:00:00Z"))).toBe(false);
});

test("read on the sandbox's own clock, summer and winter alike, not the container's UTC", () => {
    const night = { from: "23:00", to: "07:00" };
    // 22:30 UTC in November is 23:30 in Warsaw (UTC+1); in July (UTC+2) 21:30 UTC is 23:30.
    expect(withinNight(night, WARSAW, at("2026-11-04T22:30:00Z"))).toBe(true);
    expect(withinNight(night, WARSAW, at("2026-07-04T21:30:00Z"))).toBe(true);
    // 06:30 UTC in November is 07:30 in Warsaw: morning there, though still before 07:00 UTC.
    expect(withinNight(night, WARSAW, at("2026-11-05T06:30:00Z"))).toBe(false);
});

test("its length is said in minutes across midnight", () => {
    expect(nightLength({ from: "23:00", to: "07:00" })).toBe(8 * 60);
    expect(nightLength({ from: "01:30", to: "09:15" })).toBe(7 * 60 + 45);
    expect(nightLength({ from: "07:00", to: "07:00" })).toBe(0);
});

test("a time that is not a wall-clock time is refused at the edge", () => {
    expect(NightHoursSchema.safeParse({ from: "24:00" }).success).toBe(false);
    expect(NightHoursSchema.safeParse({ to: "7:00" }).success).toBe(false);
    expect(NightHoursSchema.safeParse({ from: "22:45", to: "06:10" }).success).toBe(true);
});
