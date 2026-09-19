const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days left on a deleted sandbox's recovery window, rounded UP: an hour to go still reads "1 day", never "0". */
export const daysLeft = (purgeAfter: string, now: number = Date.now()): number =>
    Math.max(0, Math.ceil((new Date(purgeAfter).getTime() - now) / DAY_MS));
