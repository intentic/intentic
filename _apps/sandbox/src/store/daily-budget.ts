/* A CEILING ON A PUBLIC ENDPOINT'S DAY, counted in memory against the UTC day.
 *
 * Every door this daemon opens to a caller with no identity needs one, and for the same reason: a per-minute
 * rate window bounds the RATE without bounding the DAY. Twenty a minute, sustained, is tens of thousands of
 * agent turns before anyone notices — and every one of them is billed to the owner.
 *
 * DELIBERATELY NOT PERSISTED. Its job is to bound a runaway day, and a daemon restart resetting it is a smaller
 * problem than a counter file written on every inbound request. Anything that must survive a restart rides a
 * record that was being written anyway (the Doorbell's per-conversation ceiling rides its thread session).
 *
 * ponytail: in-memory, per daemon — swap for a shared store only if the sandbox ever runs multi-process.
 */

const dayOf = (now: number): number => Math.floor(now / 86_400_000);

export interface DailyBudget {
    /* Spend one against `key`'s allowance, and say whether that was refused. True ⇒ the caller is over and
     * NOTHING was spent; false ⇒ the call is admitted and counted.
     *
     * Check-and-increment in one call rather than a read and a later write, because the two are always wanted
     * together and a gap between them is a ceiling that leaks under concurrency.
     */
    readonly spend: (key: string, max: number, now: number) => boolean;
}

export const dailyBudget = (): DailyBudget => {
    const counts = new Map<string, { day: number; count: number }>();
    return {
        spend: (key, max, now) => {
            const day = dayOf(now);
            const current = counts.get(key);
            const count = current !== undefined && current.day === day ? current.count : 0;
            if (count >= max) {
                return true;
            }
            counts.set(key, { day, count: count + 1 });
            return false;
        },
    };
};
