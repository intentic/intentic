// Published hosted figures, mirrored from the platform's own defaults (_platform/api/src/config.ts, the `hosted` and
// `hostedPlan` blocks). Derived figures (like `idleWeeks`) are computed here, not retyped, so they can't drift from the
// numbers they come from.

export const hosted = {
    // The hosted plan's monthly price in USD (HOSTED_PLAN_PRICE_USD).
    priceUsd: 20,
    // Awake hours per calendar month on the free lane (HOSTED_MONTHLY_HOURS); a sleeping machine spends none.
    freeHours: 40,
    // Minutes of inactivity before a hosted machine sleeps (HOSTED_IDLE_STOP_MINUTES).
    idleStopMinutes: 20,
    // Days unopened before removal, and the warning day (HOSTED_IDLE_DAYS, HOSTED_IDLE_WARN_DAYS); free lane only.
    idleDays: 21,
    idleWarnDays: 14,
    // The machine's shape (HOSTED_CPUS, HOSTED_MEMORY_MB, HOSTED_VOLUME_GB); same on the free lane and the plan.
    cpus: 4,
    memoryGb: 4,
    diskGb: 10,
} as const;

// The free lane's removal window in weeks, for copy that says "three weeks".
export const idleWeeks = Math.round(hosted.idleDays / 7);
