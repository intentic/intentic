import { formatClock, formatDate, formatDayMonth, formatMonth, formatWeekdayTime } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";

// When a file changed, as the home's date grouping says it (homeOrder.ts `homeGroups` with `date`): the heading it sits
// under, and the line under its name. Buckets are calendar days in the reader's own timezone, the way a file manager
// draws a Downloads folder: Today, Yesterday, the previous seven days, the previous thirty, then each earlier month of
// this year by name, then each earlier year. Pure, with `now` handed in, so the edges are tested by value.

export type DateGroupKey = `today` | `yesterday` | `week` | `month` | `undated` | `m-${string}` | `y-${string}`;

export interface DateGroup {
    readonly key: DateGroupKey;
    readonly label: string;
}

// Midnight `days` calendar days before the day of `now`, in local time. Through the calendar, never `- days * 86_400_000`:
// a day that crosses a clock change is 23 or 25 hours long, and the plain subtraction lands an hour off the edge.
const midnightBefore = (now: number, days: number): number => {
    const at = new Date(now);
    at.setHours(0, 0, 0, 0);
    at.setDate(at.getDate() - days);
    return at.getTime();
};

const pad = (value: number): string => String(value).padStart(2, `0`);

/**
 * The heading a file changed at `mtime` sits under, seen at `now`. A time ahead of `now` (a clock that disagrees, a file
 * from another machine) is today's: it is the newest thing there, which is where a reader looks for it.
 */
export const dateGroupOf = (mtime: number | undefined, now: number): DateGroup => {
    if (mtime === undefined) {
        return { key: `undated`, label: t(`workspace.homeDates.undated`) };
    }
    if (mtime >= midnightBefore(now, 0)) {
        return { key: `today`, label: t(`workspace.homeDates.today`) };
    }
    if (mtime >= midnightBefore(now, 1)) {
        return { key: `yesterday`, label: t(`workspace.homeDates.yesterday`) };
    }
    if (mtime >= midnightBefore(now, 7)) {
        return { key: `week`, label: t(`workspace.homeDates.previous7Days`) };
    }
    if (mtime >= midnightBefore(now, 30)) {
        return { key: `month`, label: t(`workspace.homeDates.previous30Days`) };
    }
    const at = new Date(mtime);
    if (at.getFullYear() === new Date(now).getFullYear()) {
        return { key: `m-${at.getFullYear()}-${pad(at.getMonth() + 1)}`, label: formatMonth(mtime) };
    }
    return { key: `y-${at.getFullYear()}`, label: String(at.getFullYear()) };
};

/**
 * The line under a file's name while the home groups by date: as much of when as its heading leaves unsaid. The clock
 * under Today and Yesterday, the weekday under the previous seven days, the day of the month this year, the full date
 * before that. Empty for a file with no time and for a folder, which keeps every tile one height.
 */
export const dateLine = (mtime: number | undefined, now: number): string => {
    if (mtime === undefined) {
        return ``;
    }
    if (mtime >= midnightBefore(now, 1)) {
        return formatClock(mtime);
    }
    if (mtime >= midnightBefore(now, 7)) {
        return formatWeekdayTime(mtime);
    }
    return new Date(mtime).getFullYear() === new Date(now).getFullYear() ? formatDayMonth(mtime) : formatDate(mtime);
};
