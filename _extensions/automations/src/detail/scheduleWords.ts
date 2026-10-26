import { type Zone, zoneLabel } from "@intentic/sandbox-contract/time";
import { dayNames, ordinal } from "../cronSchedule";
import { t } from "../i18n";

// A schedule as a sentence somebody reads once and knows: "Every 2 hours at :17", "Every hour from 09:07 to 22:07",
// "Weekdays at 17:30", "Every Mon, Wed and Thu at 11:07". The row keeps its short badge (scheduleLabel); this is the
// opened automation's, where there is room to say it whole. A shape it has no words for is undefined, and the caller
// shows the cron itself rather than a guess at it.

type Hours =
    | { readonly kind: `all` }
    | { readonly kind: `every`; readonly step: number }
    | { readonly kind: `window`; readonly from: number; readonly to: number; readonly step: number }
    | { readonly kind: `at`; readonly hours: readonly number[] };

const NUMBER = /^\d{1,2}$/;
const pad = (value: number): string => String(value).padStart(2, `0`);
const clock = (hour: number, minute: number): string => `${pad(hour)}:${pad(minute)}`;
const inRange = (value: number, min: number, max: number): boolean => Number.isInteger(value) && value >= min && value <= max;

const hoursOf = (field: string): Hours | undefined => {
    if (field === `*`) {
        return { kind: `all` };
    }
    const every = /^\*\/(\d{1,2})$/.exec(field);
    if (every !== null) {
        const step = Number(every[1]);
        return inRange(step, 1, 23) ? { kind: `every`, step } : undefined;
    }
    const window = /^(\d{1,2})-(\d{1,2})(?:\/(\d{1,2}))?$/.exec(field);
    if (window !== null) {
        const [from, to, step] = [Number(window[1]), Number(window[2]), Number(window[3] ?? 1)];
        return inRange(from, 0, 23) && inRange(to, from, 23) && inRange(step, 1, 23) ? { kind: `window`, from, to, step } : undefined;
    }
    const hours = field.split(`,`);
    return hours.every((hour) => NUMBER.test(hour) && inRange(Number(hour), 0, 23))
        ? { kind: `at`, hours: hours.map(Number).toSorted((a, b) => a - b) }
        : undefined;
};

// Cron weekdays as a sorted set, Sunday as 0 (7 is Sunday too); undefined for anything but numbers, ranges and lists.
const daysOf = (field: string): readonly number[] | undefined => {
    if (field === `*`) {
        return [0, 1, 2, 3, 4, 5, 6];
    }
    const days = new Set<number>();
    for (const part of field.split(`,`)) {
        const range = /^(\d)(?:-(\d))?$/.exec(part);
        if (range === null) {
            return undefined;
        }
        const [from, to] = [Number(range[1]), Number(range[2] ?? range[1])];
        if (!inRange(from, 0, 7) || !inRange(to, from, 7)) {
            return undefined;
        }
        for (let day = from; day <= to; day++) {
            days.add(day % 7);
        }
    }
    return [...days].toSorted((a, b) => a - b);
};

// "a", "a and b", "a, b and c", in the reader's words for "and".
const listOf = (items: readonly string[]): string =>
    items.length < 2 ? (items[0] ?? ``) : t(`scheduleWords.pair`, { first: items.slice(0, -1).join(`, `), last: items.at(-1) ?? `` });

// Monday first, as a week is read, though cron counts from Sunday.
const dayList = (days: readonly number[]): string => listOf(days.toSorted((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((day) => dayNames()[day] ?? ``));

const isWeekdays = (days: readonly number[]): boolean => days.join(`,`) === `1,2,3,4,5`;
const isWeekend = (days: readonly number[]): boolean => days.join(`,`) === `0,6`;

// A sentence that names wall-clock times, at fixed hours or within a window, on the days it runs.
const atTimes = (hours: readonly number[], minute: number, days: readonly number[]): string => {
    const times = listOf(hours.map((hour) => clock(hour, minute)));
    if (days.length === 7) {
        return t(`scheduleWords.everyDayAt`, { times });
    }
    if (isWeekdays(days)) {
        return t(`scheduleWords.weekdaysAt`, { times });
    }
    return isWeekend(days) ? t(`scheduleWords.weekendsAt`, { times }) : t(`scheduleWords.daysAt`, { days: dayList(days), times });
};

// What a repeating rule adds when it does not run every day.
const onDays = (sentence: string, days: readonly number[]): string => {
    if (days.length === 7) {
        return sentence;
    }
    if (isWeekdays(days)) {
        return t(`scheduleWords.onWeekdays`, { sentence });
    }
    return isWeekend(days) ? t(`scheduleWords.onWeekends`, { sentence }) : t(`scheduleWords.onDays`, { sentence, days: dayList(days) });
};

const repeating = (hours: Exclude<Hours, { kind: `at` }>, minute: number): string => {
    if (hours.kind === `all`) {
        return t(`scheduleWords.everyHourAt`, { minute: pad(minute) });
    }
    if (hours.kind === `every`) {
        return t(`scheduleWords.everyHoursAt`, { count: hours.step, minute: pad(minute) }, hours.step);
    }
    // The last hour it actually fires in, which a stepped window can stop short of.
    const last = hours.from + Math.floor((hours.to - hours.from) / hours.step) * hours.step;
    const span = { from: clock(hours.from, minute), to: clock(last, minute) };
    return hours.step === 1
        ? t(`scheduleWords.everyHourBetween`, span)
        : t(`scheduleWords.everyHoursBetween`, { ...span, count: hours.step }, hours.step);
};

interface Said {
    readonly sentence: string;
    // Whether it names a wall-clock time, which is what makes the zone it is kept on worth saying.
    readonly clockTime: boolean;
}

// "*/10 * * * *": every few minutes, all day, every day; any narrowing beside it is a shape this has no words for.
const everyMinutesRule = (minuteField: string, rest: string): Said | undefined => {
    const count = Number(/^\*\/(\d{1,2})$/.exec(minuteField)?.[1]);
    return rest === `* * *` && inRange(count, 1, 59) ? { sentence: t(`scheduleWords.everyMinutes`, { count }, count), clockTime: false } : undefined;
};

// One day of the month at one time; a day of the month beside weekdays, or beside several hours, is left unsaid.
const monthlyRule = (dayOfMonth: string, hours: Hours, minute: number, weekday: string): Said | undefined => {
    const day = NUMBER.test(dayOfMonth) ? Number(dayOfMonth) : Number.NaN;
    const single = hours.kind === `at` && hours.hours.length === 1 ? hours.hours[0] : undefined;
    return inRange(day, 1, 31) && single !== undefined && weekday === `*`
        ? { sentence: t(`scheduleWords.monthlyAt`, { day: ordinal(day), time: clock(single, minute) }), clockTime: true }
        : undefined;
};

const sentenceOf = (cron: string): Said | undefined => {
    const fields = cron.trim().split(/\s+/);
    if (fields.length !== 5 || fields[3] !== `*`) {
        return undefined;
    }
    const [minuteField = ``, hourField = ``, dayOfMonth = ``, , weekday = ``] = fields;
    if (minuteField.startsWith(`*/`)) {
        return everyMinutesRule(minuteField, `${hourField} ${dayOfMonth} ${weekday}`);
    }
    const minute = NUMBER.test(minuteField) ? Number(minuteField) : Number.NaN;
    const hours = hoursOf(hourField);
    const days = daysOf(weekday);
    if (!inRange(minute, 0, 59) || hours === undefined || days === undefined) {
        return undefined;
    }
    if (dayOfMonth !== `*`) {
        return monthlyRule(dayOfMonth, hours, minute, weekday);
    }
    return hours.kind === `at`
        ? { sentence: atTimes(hours.hours, minute, days), clockTime: true }
        : { sentence: onDays(repeating(hours, minute), days), clockTime: hours.kind === `window` || days.length < 7 };
};

/**
 * The schedule in words, with the clock it is kept on named only when it is not the reader's own: "Weekdays at 17:30
 * UTC" to somebody in Warsaw, "Weekdays at 17:30" to somebody in London on UTC. Undefined for a shape it cannot say.
 */
export const scheduleSentence = (cron: string, reader: Zone, rule: Zone): string | undefined => {
    const said = sentenceOf(cron);
    if (said === undefined) {
        return undefined;
    }
    const zone = said.clockTime ? zoneLabel(rule, reader) : undefined;
    return zone === undefined ? said.sentence : `${said.sentence} ${zone}`;
};
