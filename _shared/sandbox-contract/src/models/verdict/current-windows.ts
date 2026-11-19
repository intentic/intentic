import type { AccountUsage, UsageWindow } from "../../schemas/providers/plan-limits.js";
import { windowPeriod } from "./window-period.js";

// What a reading still says at a given instant: the first thing the serviceability rule does with every account's facts,
// so the daemon and every open window judge the same reading at the same instant, whoever last re-read it. Before
// 2026-11-19 the daemon lapsed a window past its reset as it read its store, and the rule did not: an editor holding the
// facts it was sent judged a Codex five-hour pool at 100% spent, "back at 12:00", at 12:05, while the daemon judged the
// same account ready with 60% left, until something made the editor read the accounts again.

// Whether a reading of this window can still be true. A published reset instant is the authority; with none, the
// window's own length is, since a pool read as empty says nothing about the window that opened after it. A window whose
// length nothing names keeps the old rule: only its reset instant can retire it.
export const windowLive = (window: UsageWindow, measuredAt: number, now: number): boolean => {
    if (window.resetsAt !== undefined) {
        return window.resetsAt * 1000 > now;
    }
    const period = windowPeriod(window);
    return period === undefined || measuredAt + period.seconds * 1000 > now;
};

// A pool whose reading belongs to a window that has since closed: still the account's pool, at the floor any new window
// starts from, and marked with when the old window closed so a surface can say it has not been re-read since.
const lapsedWindow = (window: UsageWindow, measuredAt: number): UsageWindow => {
    const { resetsAt, rounded: _rounded, utilization: _utilization, ...pool } = window;
    // Only reached for a window windowLive retired, so with no published reset its length is known.
    const closedAt = resetsAt ?? Math.floor((measuredAt + (windowPeriod(window)?.seconds ?? 0) * 1000) / 1000);
    return { ...pool, utilization: 0, lapsedAt: closedAt };
};

// What a reading says about each of the account's pools now. A window past its reset is kept rather than dropped, as a
// lapsed pool (lapsedWindow): dropping it made a reading whose re-reads were failing lose its five-hour row within hours
// while the weekly rows stayed, a partial card that reads as complete. The floor of 0 is what dropping it already meant
// to every verdict (an absent pool binds nothing). A reading with no window still current says nothing about now and
// answers none, so the account reads as unmeasured. Idempotent: a pool already lapsed stays as it is.
// A pool the provider stopped reporting (`missingSince`) is dropped instead once its window closes: nothing will read it
// again, so its floor of 0 would be a pool that is not there.
export const currentWindows = (usage: AccountUsage, now: number): UsageWindow[] => {
    const live = (window: UsageWindow): boolean => window.lapsedAt === undefined && windowLive(window, usage.measuredAt, now);
    if (!usage.windows.some(live)) {
        return [];
    }
    return usage.windows.flatMap((window) => {
        if (window.lapsedAt !== undefined || live(window)) {
            return [window];
        }
        return window.missingSince === undefined ? [lapsedWindow(window, usage.measuredAt)] : [];
    });
};

/**
 * A reading as it stands at `now` (currentWindows), or undefined where no window of it is still current. Idempotent, and
 * the very reading it was given where nothing in it has lapsed, so a surface comparing readings by identity sees no change.
 */
export const usageAt = (usage: AccountUsage | undefined, now: number): AccountUsage | undefined => {
    if (usage === undefined) {
        return undefined;
    }
    const windows = currentWindows(usage, now);
    if (windows.length === 0) {
        return undefined;
    }
    return windows.length === usage.windows.length && windows.every((window, index) => window === usage.windows[index]) ? usage : { ...usage, windows };
};

/** One account's facts with its reading as it stands at `now` (usageAt): what every verdict judges. */
export const factsAt = <T extends { readonly usage?: AccountUsage | undefined }>(facts: T, now: number): T => {
    if (facts.usage === undefined) {
        return facts;
    }
    const usage = usageAt(facts.usage, now);
    if (usage === facts.usage) {
        return facts;
    }
    // An absent reading is spelled as `usage: undefined`, which every reader of the facts treats as not measured.
    return { ...facts, usage };
};

/**
 * The soonest instant after `now` at which a reading changes by the clock alone: a current window's reset, or the end of
 * the length a window with no published reset is trusted for. Epoch ms; undefined where nothing in it is due to lapse.
 */
export const usageLapsesAt = (usage: AccountUsage | undefined, now: number): number | undefined => {
    if (usage === undefined) {
        return undefined;
    }
    const ends = usage.windows.flatMap((window) => {
        if (window.lapsedAt !== undefined) {
            return [];
        }
        const period = windowPeriod(window);
        const at = window.resetsAt !== undefined ? window.resetsAt * 1000 : period === undefined ? undefined : usage.measuredAt + period.seconds * 1000;
        return at !== undefined && at > now ? [at] : [];
    });
    return ends.length === 0 ? undefined : Math.min(...ends);
};
