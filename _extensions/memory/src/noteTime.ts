import { timeAgo } from "@intentic/extension-ui";

/* Freshness at the width this view has for it. `timeAgo` is the app's shared phrasing and is used verbatim
 * while it stays relative, but past a day it falls back to a full local timestamp ("7/27/2026, 9:06:40 PM") —
 * three times the width of a note row's whole meta line, and two wrapped lines in the reader on a phone.
 *
 * Memory is measured in days and weeks rather than minutes, so that fallback is the common case here, not the
 * rare one. Anything older than the relative tiers shows as a bare date; every caller pairs this with the
 * exact moment in a `title`, so nothing is lost — it just stops setting the width of the row it sits in. */
export const freshness = (at: number): string => (Date.now() - at < 86_400_000 ? timeAgo(at) : new Date(at).toLocaleDateString());
