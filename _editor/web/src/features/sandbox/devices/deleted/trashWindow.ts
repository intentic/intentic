const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days left on a deleted sandbox's recovery window, rounded UP: an hour to go still reads "1 day", never "0". */
export const daysLeft = (purgeAfter: string, now: number = Date.now()): number =>
    Math.max(0, Math.ceil((new Date(purgeAfter).getTime() - now) / DAY_MS));

/** What the board's Recently deleted section draws; `hidden` leaves no trace on the board at all. */
export type TrashSection = `hidden` | `reading` | `error` | `empty` | `rows`;

/**
 * The section is the board's footnote, not one of its machines: it appears when there is something to have back, and
 * otherwise only for a reader who came for it (`/devices#deleted`, the delete dialog's link). An empty or unreadable
 * trash on every visit would be noise, and on a box that cannot reach the platform a red notice that never goes away.
 */
export const trashSection = (state: {
    readonly rows: number;
    readonly read: boolean;
    readonly readError: boolean;
    readonly asked: boolean;
}): TrashSection => {
    if (state.rows > 0) {
        return `rows`;
    }
    if (!state.asked) {
        return `hidden`;
    }
    if (state.readError) {
        return `error`;
    }
    return state.read ? `empty` : `reading`;
};
