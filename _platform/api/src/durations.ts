/* Every retention sweep, admin rollup, idle collection and alert latch here is a multiple of one of these, and each module had spelled its own out. */
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
