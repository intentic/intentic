import { formatUntil } from "@intentic/ui/time";
import { bookable, bookingOf, HOUR_CHOICES, hourChoices, LATEST_SEND_MS, laterLabel, laterOfQueue, SOONEST_SEND_MS, timeChoices, waitText } from "./sendLater";

// When the next message goes, when not now: the quick times the panel offers against the reader's own clock, how a
// picked time is said, the bounds the sandbox keeps a booking within, and the wire's spelling of a pick. Every instant
// is built on the reader's own clock, so the suite reads the same in any zone.

const at = (day: number, hour: number, minute = 0): number => new Date(2026, 9, day, hour, minute).getTime();
const HOUR = 60 * 60 * 1_000;

// 2026-10-02 is a Friday.
const FRIDAY = 2;

describe(`the quick times`, () => {
    it(`offers an hour and three out, tonight, tomorrow morning, and from a Friday Monday morning`, () => {
        const choices = timeChoices(at(FRIDAY, 14, 0));
        expect(choices.map((choice) => choice.key)).toEqual([`hour`, `hours`, `tonight`, `morning`, `monday`]);
        expect(choices.map((choice) => choice.label)).toEqual([`In an hour`, `In 3 hours`, `Tonight`, `Tomorrow morning`, `Monday morning`]);
        expect(choices.map((choice) => choice.at)).toEqual([at(FRIDAY, 15), at(FRIDAY, 17), at(FRIDAY, 22), at(3, 9), at(5, 9)]);
    });

    it(`rounds the near ones up to the next whole minute`, () => {
        const [hour, hours] = timeChoices(at(FRIDAY, 14, 0) + 37_000);
        expect(hour?.at).toBe(at(FRIDAY, 15, 1));
        expect(hours?.at).toBe(at(FRIDAY, 17, 1));
    });

    // Tonight earns its row only while it is further than the three hours the row above already reaches.
    it(`leaves tonight out once it is no further than three hours away`, () => {
        expect(timeChoices(at(FRIDAY, 19, 0)).map((choice) => choice.key)).toEqual([`hour`, `hours`, `morning`, `monday`]);
        expect(timeChoices(at(FRIDAY, 18, 59)).map((choice) => choice.key)).toContain(`tonight`);
    });

    // A Saturday's Monday is two days out; a Sunday's tomorrow already is Monday; a weekday has no weekend to skip.
    it(`offers Monday morning only from a Friday or a Saturday`, () => {
        expect(timeChoices(at(3, 10)).find((choice) => choice.key === `monday`)?.at).toBe(at(5, 9));
        expect(timeChoices(at(4, 10)).map((choice) => choice.key)).not.toContain(`monday`);
        expect(timeChoices(at(7, 10)).map((choice) => choice.key)).not.toContain(`monday`);
    });
});

// The send menu's first choice is an hour: half a day of whole hours, the night ones too, a later day said once.
describe(`the hours`, () => {
    it(`offers the next twelve whole hours, marking the ones past midnight`, () => {
        const hours = hourChoices(at(FRIDAY, 18, 21));
        expect(hours).toHaveLength(HOUR_CHOICES);
        expect(hours.map((hour) => new Date(hour.at).getHours())).toEqual([19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6]);
        expect(hours.map((hour) => hour.nextDay)).toEqual([false, false, false, false, false, true, true, true, true, true, true, true]);
        expect(hours[5]?.at).toBe(at(3, 0));
    });

    // Closer than the soonest a booking may be, the next hour is "now" with extra steps: the grid starts one later.
    it(`skips an hour less than a minute away`, () => {
        expect(hourChoices(at(FRIDAY, 13, 59) + 30_000)[0]?.at).toBe(at(FRIDAY, 15));
        expect(hourChoices(at(FRIDAY, 13, 58))[0]?.at).toBe(at(FRIDAY, 14));
    });

    it(`says the wait under each hour in hours and minutes`, () => {
        const now = at(FRIDAY, 18, 21);
        expect(waitText(at(FRIDAY, 19), now)).toBe(`39m`);
        expect(waitText(at(FRIDAY, 20, 21), now)).toBe(`2h`);
        expect(waitText(at(3, 2), now)).toBe(`7h 39m`);
    });
});

describe(`a picked time, said`, () => {
    it(`names the agent a message waits on by its card, or as another agent once no card does`, () => {
        const titleOf = (id: string): string | undefined => (id === `brave-otter` ? `Fix the login bug` : undefined);
        expect(laterLabel({ kind: `after`, conversationId: `brave-otter` }, 0, titleOf)).toBe(`After Fix the login bug lands`);
        expect(laterLabel({ kind: `after`, conversationId: `gone-fox` }, 0, titleOf)).toBe(`After another agent lands`);
        expect(laterLabel({ kind: `at`, at: at(3, 9) }, at(FRIDAY, 14), titleOf)).toBe(formatUntil(at(3, 9), at(FRIDAY, 14)));
    });
});

describe(`what can be booked`, () => {
    it(`keeps a time between a minute and thirty days ahead, the edges included`, () => {
        const now = at(FRIDAY, 14);
        expect(bookable(now + SOONEST_SEND_MS, now)).toBe(true);
        expect(bookable(now + SOONEST_SEND_MS - 1, now)).toBe(false);
        expect(bookable(now + LATEST_SEND_MS, now)).toBe(true);
        expect(bookable(now + LATEST_SEND_MS + 1, now)).toBe(false);
        expect(LATEST_SEND_MS).toBe(30 * 24 * HOUR);
    });
});

describe(`a pick on the wire, and back`, () => {
    it(`spells a time as sendAt and an agent as sendAfter`, () => {
        expect(bookingOf({ kind: `at`, at: 5_000 })).toEqual({ sendAt: 5_000 });
        expect(bookingOf({ kind: `after`, conversationId: `brave-otter` })).toEqual({ sendAfter: `brave-otter` });
    });

    // The queue's own fields: every message's booking from a sandbox that books the whole queue, the soonest message's
    // from one that books each (bookings.test.ts has the messages' own).
    it(`reads a scheduled queue's hold back as the pick that re-times it, and nothing from any other hold`, () => {
        expect(laterOfQueue({ paused: `scheduled`, until: 5_000 })).toEqual({ kind: `at`, at: 5_000 });
        expect(laterOfQueue({ paused: `scheduled`, after: `brave-otter` })).toEqual({ kind: `after`, conversationId: `brave-otter` });
        expect(laterOfQueue({ paused: `stopped` })).toBeUndefined();
        expect(laterOfQueue({ paused: `scheduled` })).toBeUndefined();
        expect(laterOfQueue(undefined)).toBeUndefined();
    });
});
