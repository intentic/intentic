/* THE PUBLISHED HOSTED FIGURES: what the hosted plan costs, and the free lane's ceilings. Mirrored from the
 * platform's own defaults (_platform/api/src/config.ts, the `hosted` and `hostedPlan` blocks) so the site
 * states one set of numbers from one place instead of retyping them into every page that mentions money.
 *
 * WHAT IS DERIVED IS NOT WRITTEN. A sentence reading "three weeks unopened" stays on the page long after the
 * 21 that made it true has moved, and nothing fails to warn anybody. Written once as arithmetic, the derived
 * figures cannot disagree with the ones they come from. */

export const hosted = {
    // The hosted plan's monthly price in USD (HOSTED_PLAN_PRICE_USD).
    priceUsd: 20,
    // The free lane's awake hours per calendar month (HOSTED_MONTHLY_HOURS). Awake hours: a sleeping machine
    // spends none.
    freeHours: 40,
    // Minutes of inactivity before a hosted machine sleeps (HOSTED_IDLE_STOP_MINUTES).
    idleStopMinutes: 20,
    // Days unopened before a free-lane machine is removed, and the day the warning email goes out
    // (HOSTED_IDLE_DAYS, HOSTED_IDLE_WARN_DAYS). Never applies on the plan.
    idleDays: 21,
    idleWarnDays: 14,
    // The machine's shape (HOSTED_CPUS, HOSTED_MEMORY_MB, HOSTED_VOLUME_GB), the same on the free lane and the plan.
    cpus: 4,
    memoryGb: 4,
    diskGb: 10,
} as const;

// The free lane's removal window in weeks, for copy that says "three weeks".
export const idleWeeks = Math.round(hosted.idleDays / 7);
