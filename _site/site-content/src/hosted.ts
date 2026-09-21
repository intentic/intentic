// Published hosted figures. The machine ladder itself — shapes, hours, prices — comes from `@intentic/constants`
// (hosted-tiers), the same module the platform's config defaults read, so a rung cannot say one thing here and another
// in the product. What stays here is what the site alone states: the lane's lifecycle knobs, mirrored from the
// platform's `hosted` config block, and the phrasings derived from them.

export const hosted = {
    // A new account's ceiling for its first days (HOSTED_NEW_ACCOUNT_HOURS, HOSTED_NEW_ACCOUNT_DAYS), then the month's.
    newAccountHours: 10,
    newAccountDays: 7,
    // Minutes of inactivity before a hosted machine sleeps (HOSTED_IDLE_STOP_MINUTES).
    idleStopMinutes: 20,
    // Days unopened before removal, and the warning day (HOSTED_IDLE_DAYS, HOSTED_IDLE_WARN_DAYS); free plan only.
    idleDays: 21,
    idleWarnDays: 14,
} as const;

// The free plan's removal window in weeks, for copy that says "three weeks".
export const idleWeeks = Math.round(hosted.idleDays / 7);

// The ramp's span as a person says it: "your first week", or "your first 10 days".
export const rampSpan = hosted.newAccountDays === 7 ? `your first week` : `your first ${hosted.newAccountDays} days`;
