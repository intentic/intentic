import { formatDate, timeAgo } from "@intentic/extension-ui";

/* Freshness at the width these rows have for it. `timeAgo` is the app's shared phrasing and is used verbatim
 * while it stays relative, but past a day it falls back to a full timestamp — three times the width of a row's
 * whole meta line. A knowledge note is measured in weeks and months rather than minutes, so that fallback is
 * the common case here, not the rare one, and it would set the width of every row it appeared in.
 *
 * Every caller pairs this with the exact moment in a `title`, so nothing is lost. Same rule, and the same
 * reason, as the memory extension's. */
export const freshness = (at: number): string => (Date.now() - at < 86_400_000 ? timeAgo(at) : formatDate(at));
