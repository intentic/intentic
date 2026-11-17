import { asZone, UTC } from "../time/zone.js";
import { morningAfter, nightAt, nightByHandUntil, NightHoursSchema, nightLength, withinNight } from "./night-hours.js";

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

test("the morning after an instant is the next time the clock reads `to`, today's or tomorrow's", () => {
    expect(morningAfter({ to: "07:00" }, UTC, at("2026-11-04T21:40:00Z"))).toBe(at("2026-11-05T07:00:00Z"));
    expect(morningAfter({ to: "07:00" }, UTC, at("2026-11-05T02:00:00Z"))).toBe(at("2026-11-05T07:00:00Z"));
    // `to` itself is already the morning: the one after it is a day away.
    expect(morningAfter({ to: "07:00" }, UTC, at("2026-11-05T07:00:00Z"))).toBe(at("2026-11-06T07:00:00Z"));
    // On the sandbox's clock: 07:00 in Warsaw is 06:00 UTC in winter, 05:00 UTC in summer.
    expect(morningAfter({ to: "07:00" }, WARSAW, at("2026-11-04T21:40:00Z"))).toBe(at("2026-11-05T06:00:00Z"));
    expect(morningAfter({ to: "07:00" }, WARSAW, at("2026-07-04T21:40:00Z"))).toBe(at("2026-07-05T05:00:00Z"));
    // Across the October changeover the clock goes back an hour overnight; the morning is still 07:00 on the wall.
    expect(morningAfter({ to: "07:00" }, WARSAW, at("2026-10-24T20:00:00Z"))).toBe(at("2026-10-25T06:00:00Z"));
});

test("a night begun by hand lasts until that morning, whatever the hours or the switch say", () => {
    const hours = NightHoursSchema.parse({ on: false, asleepSince: at("2026-11-04T21:40:00Z") });
    expect(nightByHandUntil(hours, UTC, at("2026-11-04T21:40:00Z"))).toBe(at("2026-11-05T07:00:00Z"));
    expect(nightAt(hours, UTC, at("2026-11-04T22:00:00Z"))).toBe(true);
    expect(nightAt(hours, UTC, at("2026-11-05T06:59:00Z"))).toBe(true);
    expect(nightAt(hours, UTC, at("2026-11-05T07:00:00Z"))).toBe(false);
    // Read a minute behind the press (a fast browser, a clock that ticks by the minute), it has begun all the same.
    expect(nightAt(hours, UTC, at("2026-11-04T21:39:00Z"))).toBe(true);
    // Long before the press it was an ordinary evening, and the next evening is one again.
    expect(nightAt(hours, UTC, at("2026-11-04T21:00:00Z"))).toBe(false);
    expect(nightAt(hours, UTC, at("2026-11-05T23:30:00Z"))).toBe(false);
});

test("without a night begun by hand, it is night only inside switched-on hours", () => {
    expect(nightAt(NightHoursSchema.parse({ on: true }), UTC, at("2026-11-04T23:30:00Z"))).toBe(true);
    expect(nightAt(NightHoursSchema.parse({ on: false }), UTC, at("2026-11-04T23:30:00Z"))).toBe(false);
    expect(nightByHandUntil(NightHoursSchema.parse({ on: true }), UTC, at("2026-11-04T23:30:00Z"))).toBeUndefined();
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
