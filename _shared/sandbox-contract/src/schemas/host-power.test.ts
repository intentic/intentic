import { HostPowerFindingSchema, pauseUntilFor, restartBlocks, UPDATE_PAUSE_MAX_MS } from "./host-power.js";

// What answers Windows Update's night restart (2026-11-27): how long a pause holds for work booked on the PC, and whether
// a restart still stops that work once paused or once the PC starts its sandboxes by itself.

const HOUR = 3_600_000;
// 2026-11-26 23:35 UTC: 00:35 on 2026-11-27 on rog, an hour east of UTC.
const NOW = Date.UTC(2026, 10, 26, 23, 35);
const ROG = 60;
// rog's restart window: outside active hours 08:00 to 02:00.
const NIGHT = { window: { fromHour: 2, toHour: 8 } };
// The work booked on rog for Friday 05:00 local, which is 04:00 UTC.
const FRIDAY_FIVE = Date.UTC(2026, 10, 28, 4, 0);

describe("pauseUntilFor", () => {
    it("holds Windows Update until the end of the restart window the work falls in, on the PC's own clock", () => {
        // Friday 08:00 local is 07:00 UTC.
        expect(pauseUntilFor(NIGHT, ROG, NOW, FRIDAY_FIVE)).toBe(Date.UTC(2026, 10, 28, 7, 0));
    });

    it("holds through the next window when the work falls outside one, so a restart never lands just after it", () => {
        // Friday 10:00 local: the next window ends Saturday 08:00 local.
        expect(pauseUntilFor(NIGHT, ROG, NOW, Date.UTC(2026, 10, 28, 9, 0))).toBe(Date.UTC(2026, 10, 29, 7, 0));
        // Exactly at the window's end is the end.
        expect(pauseUntilFor(NIGHT, ROG, NOW, Date.UTC(2026, 10, 28, 7, 0))).toBe(Date.UTC(2026, 10, 28, 7, 0));
    });

    it("holds two hours past the work where no window was said, and refuses what Windows could not pause for", () => {
        expect(pauseUntilFor({}, ROG, NOW, FRIDAY_FIVE)).toBe(FRIDAY_FIVE + 2 * HOUR);
        expect(pauseUntilFor({}, ROG, NOW, NOW + UPDATE_PAUSE_MAX_MS)).toBeUndefined();
        expect(pauseUntilFor({}, ROG, NOW, NOW + UPDATE_PAUSE_MAX_MS - 2 * HOUR)).toBe(NOW + UPDATE_PAUSE_MAX_MS);
    });
});

describe("restartBlocks", () => {
    it("stops work whose span crosses the window, and not once paused past the work or once the PC brings its sandboxes back", () => {
        expect(restartBlocks(NIGHT, ROG, NOW, FRIDAY_FIVE)).toBe(true);
        expect(restartBlocks({ ...NIGHT, pausedUntil: Date.UTC(2026, 10, 28, 7, 0) }, ROG, NOW, FRIDAY_FIVE)).toBe(false);
        expect(restartBlocks({ ...NIGHT, comesBack: "boot" }, ROG, NOW, FRIDAY_FIVE)).toBe(false);
        // A pause ending Thursday 06:00 local leaves Friday's window from 02:00.
        expect(restartBlocks({ ...NIGHT, pausedUntil: Date.UTC(2026, 10, 27, 5, 0) }, ROG, NOW, FRIDAY_FIVE)).toBe(true);
    });
});

describe("HostPowerFindingSchema", () => {
    it("reads what brings the sandboxes back as unknown when a newer agent says something this build does not know", () => {
        expect(HostPowerFindingSchema.parse({ id: "update-restart", fixable: false, text: "x", comesBack: "wake-on-lan" }).comesBack).toBeUndefined();
        expect(HostPowerFindingSchema.parse({ id: "update-restart", fixable: false, text: "x", comesBack: "boot", offers: ["update-pause"] })).toMatchObject({
            comesBack: "boot",
            offers: ["update-pause"],
        });
    });
});
