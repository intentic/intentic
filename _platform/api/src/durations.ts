/* THE TIME UNITS THE PLATFORM'S WINDOWS ARE WRITTEN IN.
 *
 * Every retention sweep, admin rollup, idle collection and alert latch here is a multiple of one of these, and
 * each module had spelled its own out — seven copies of `24 * 60 * 60 * 1000` plus two of `86_400_000`, which
 * is the same number in two notations and therefore not obviously the same number at all.
 *
 * Only the units, not the windows. How long a thing is kept, or how often it may mail somebody, is a policy
 * that belongs beside the thing it governs (and usually in config.ts, where it can be changed without a
 * deploy). What lives here is the arithmetic nobody should have to re-check. */
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
