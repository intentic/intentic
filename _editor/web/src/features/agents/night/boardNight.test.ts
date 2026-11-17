// Pins what the board's moon says: day with the morning a night begun now would end at, a night begun by hand until
// that morning, and the owner's own hours, which win over a night begun inside them and which the board cannot end.
import { NightHoursSchema } from "@intentic/sandbox-contract/schemas/night-hours";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { beginNight, boardNight, endNight } from "./boardNight";

const at = (iso: string): number => Date.parse(iso);
const settingsWith = (nightHours: Partial<ReturnType<typeof NightHoursSchema.parse>>, timezone = `UTC`) =>
    SandboxSettingsSchema.parse({ timezone, nightHours: NightHoursSchema.parse(nightHours) });

test(`by day it offers a night until the next morning`, () => {
    expect(boardNight(settingsWith({}), at(`2026-11-04T21:40:00Z`))).toEqual({ kind: `day`, until: at(`2026-11-05T07:00:00Z`) });
    // Past this morning's end, the morning offered is tomorrow's.
    expect(boardNight(settingsWith({}), at(`2026-11-05T09:00:00Z`))).toEqual({ kind: `day`, until: at(`2026-11-06T07:00:00Z`) });
});

test(`a night begun by hand lasts until the morning, with the switch off, and is day again after it`, () => {
    const begun = settingsWith({ on: false, asleepSince: at(`2026-11-04T21:40:00Z`) });
    expect(boardNight(begun, at(`2026-11-05T02:00:00Z`))).toEqual({ kind: `hand`, until: at(`2026-11-05T07:00:00Z`), since: at(`2026-11-04T21:40:00Z`) });
    expect(boardNight(begun, at(`2026-11-05T07:00:00Z`)).kind).toBe(`day`);
});

test(`read off a minute clock that has not ticked since the press, the night has begun already`, () => {
    const begun = settingsWith({ asleepSince: at(`2026-11-04T21:40:30Z`) });
    expect(boardNight(begun, at(`2026-11-04T21:40:00Z`)).kind).toBe(`hand`);
});

test(`inside the owner's hours it is their night, even one begun by hand before them`, () => {
    const hours = settingsWith({ on: true, from: `23:00`, to: `07:00`, asleepSince: at(`2026-11-04T21:40:00Z`) });
    expect(boardNight(hours, at(`2026-11-04T23:30:00Z`))).toEqual({ kind: `hours`, until: at(`2026-11-05T07:00:00Z`) });
    // Before they begin, the night begun by hand is the one in force.
    expect(boardNight(hours, at(`2026-11-04T22:00:00Z`)).kind).toBe(`hand`);
});

test(`the morning is the sandbox clock's, drawn as an instant`, () => {
    // 07:00 in Warsaw is 06:00 UTC in November.
    expect(boardNight(settingsWith({}, `Europe/Warsaw`), at(`2026-11-04T21:40:00Z`)).until).toBe(at(`2026-11-05T06:00:00Z`));
});

test(`beginning and ending a night move only the stamp, since settings are written whole`, () => {
    const hours = NightHoursSchema.parse({ on: true, from: `22:30`, questions: `defer` });
    const begun = beginNight(hours, 1234);
    expect(begun).toEqual({ ...hours, asleepSince: 1234 });
    expect(endNight(begun)).toEqual(hours);
    expect(`asleepSince` in endNight(begun)).toBe(false);
});
