import type { LocationQuery } from "vue-router";

/**
 * The name a page's look is remembered under: its path, and the part it has open when it has parts (`?section=`, as
 * Agent, Activity and Access have). Each part is a different page to look at, so remembering them under the path alone
 * drew a cold load of `?section=instructions` as whichever part was seen last. Nothing else in the query is part of the
 * name: an address like `?provider=` or `?file=` picks what a page shows, not how it is laid out.
 */
export const pageImprint = (route: { readonly path: string; readonly query: LocationQuery }): string => {
    const section = route.query[`section`];
    // One part at a time: an empty or repeated `section` names none, as the pages with parts read it.
    return section === undefined || section === null || section === `` || Array.isArray(section) ? route.path : `${route.path}?section=${section}`;
};
