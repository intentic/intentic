import type { RouteLocationRaw } from "vue-router";

// Activity's three parts, by who can read each: the turns are the Activity extension's view, which a member sees
// narrowed to their own conversations; every command the judge checked and every request the privacy shield handled are
// a maintainer's, as the daemon refuses their logs below. In the query, as the Agent and Audit tabs' parts are, so a
// settings page links straight to its record; the first writes no param.
export const ACTIVITY_PARTS = [`turns`, `commands`, `personal`] as const;
export type ActivityPart = (typeof ACTIVITY_PARTS)[number];

export const activityPart = (part: ActivityPart): RouteLocationRaw => ({
    name: `sandbox`,
    params: { tab: `activity` },
    query: part === `turns` ? {} : { section: part },
});
