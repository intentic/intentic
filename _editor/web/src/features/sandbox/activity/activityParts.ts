import type { RouteLocationRaw } from "vue-router";

// Activity's four parts, by who can read each: the turns are the Activity extension's view, which a member sees
// narrowed to their own conversations; every command the judge checked, every request the privacy shield handled and
// the audit trail of what people did are a maintainer's, as the daemon refuses their logs below. In the query, as the
// Agent tab's parts are, so a settings page links straight to its record; the first writes no param. The audit trail
// was a hub row of its own until 2026-10-17, and its old address lands on its part (router/index.ts).
export const ACTIVITY_PARTS = [`turns`, `commands`, `personal`, `audit`] as const;
export type ActivityPart = (typeof ACTIVITY_PARTS)[number];

export const activityPart = (part: ActivityPart): RouteLocationRaw => ({
    name: `sandbox`,
    params: { tab: `activity` },
    query: part === `turns` ? {} : { section: part },
});
