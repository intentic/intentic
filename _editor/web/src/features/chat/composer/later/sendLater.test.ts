import { formatClock, formatDayMonthTime, formatWeekdayTime } from "@intentic/ui/format";
import {
    bookable,
    bookingOf,
    instantOfInput,
    LATEST_SEND_MS,
    laterLabel,
    laterOfQueue,
    localInputOf,
    SOONEST_SEND_MS,
    sendTimeLabel,
    timeChoices,
} from "./sendLater";

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

describe(`a picked time, said`, () => {
    it(`reads as a calendar does: the clock today, tomorrow's by name, then the weekday, then the date`, () => {
        const now = at(FRIDAY, 14);
        expect(sendTimeLabel(at(FRIDAY, 22), now)).toBe(formatClock(at(FRIDAY, 22)));
        expect(sendTimeLabel(at(3, 9), now)).toBe(`Tomorrow ${formatClock(at(3, 9))}`);
        expect(sendTimeLabel(at(5, 9), now)).toBe(formatWeekdayTime(at(5, 9)));
        expect(sendTimeLabel(at(20, 9), now)).toBe(formatDayMonthTime(at(20, 9)));
    });

    it(`names the agent a message waits on by its card, or as another agent once no card does`, () => {
        const titleOf = (id: string): string | undefined => (id === `brave-otter` ? `Fix the login bug` : undefined);
        expect(laterLabel({ kind: `after`, conversationId: `brave-otter` }, 0, titleOf)).toBe(`After Fix the login bug lands`);
        expect(laterLabel({ kind: `after`, conversationId: `gone-fox` }, 0, titleOf)).toBe(`After another agent lands`);
        expect(laterLabel({ kind: `at`, at: at(3, 9) }, at(FRIDAY, 14), titleOf)).toBe(`Tomorrow ${formatClock(at(3, 9))}`);
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

    it(`reads the browser's date field on the reader's own clock, and nothing from a half-typed one`, () => {
        expect(localInputOf(at(3, 9, 5))).toBe(`2026-10-03T09:05`);
        expect(instantOfInput(`2026-10-03T09:05`)).toBe(at(3, 9, 5));
        expect(instantOfInput(localInputOf(at(20, 23, 59)))).toBe(at(20, 23, 59));
        expect(instantOfInput(``)).toBeUndefined();
        expect(instantOfInput(`2026-10-03`)).toBeUndefined();
    });
});

describe(`a pick on the wire, and back`, () => {
    it(`spells a time as sendAt and an agent as sendAfter`, () => {
        expect(bookingOf({ kind: `at`, at: 5_000 })).toEqual({ sendAt: 5_000 });
        expect(bookingOf({ kind: `after`, conversationId: `brave-otter` })).toEqual({ sendAfter: `brave-otter` });
    });

    it(`reads a scheduled queue's hold back as the pick that re-times it, and nothing from any other hold`, () => {
        expect(laterOfQueue({ paused: `scheduled`, until: 5_000 })).toEqual({ kind: `at`, at: 5_000 });
        expect(laterOfQueue({ paused: `scheduled`, after: `brave-otter` })).toEqual({ kind: `after`, conversationId: `brave-otter` });
        expect(laterOfQueue({ paused: `stopped` })).toBeUndefined();
        expect(laterOfQueue({ paused: `scheduled` })).toBeUndefined();
        expect(laterOfQueue(undefined)).toBeUndefined();
    });
});
