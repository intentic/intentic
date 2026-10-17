import type { LocationQuery } from "vue-router";

// The entry open on either Extensions list rides `?ext=` beside the `view` pill: an installed extension's id on
// Installed, a listing's name on Browse. The view tells the two apart, and switching views drops it.
export const openEntryOf = (query: LocationQuery): string | undefined => [query[`ext`]].flat()[0] ?? undefined;
