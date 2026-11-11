import type { LocationQuery } from "vue-router";

// THE RAIL THIS COMPUTER ARRIVES WITH (2026-11-11). Asked for from the workspace (its rail's This computer tile, Alt+0), a
// local window comes up wearing the rail the workspace had at the press, as a sandbox picked on that rail does: unrolled
// onto every sandbox with This computer lit among them, or folded onto its own sections. The workspace says which on its
// link (desktop.ts `openThisComputer`), and the app hands it on as a word on the route it takes this window to
// (`/workspace?rail=unrolled`, setup_link.rs), on a window it builds as on one already up. The word sets the rail and is
// taken off the address: it says how the window arrived, not where it is.

const RAIL = `rail`;

/** The rail an arrival's route asks for: unrolled (`true`), folded (`false`), or none named. Pure. */
export const arrivingRail = (query: LocationQuery): boolean | undefined => {
    const word = query[RAIL];
    return word === `unrolled` ? true : word === `folded` ? false : undefined;
};

/** The route's query with the rail's word taken off. Pure. */
export const withoutRail = (query: LocationQuery): LocationQuery => {
    const { [RAIL]: _rail, ...rest } = query;
    return rest;
};
