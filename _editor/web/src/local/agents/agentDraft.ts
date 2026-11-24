import type { LocationQuery } from "vue-router";

// A FIRST MESSAGE HANDED IN ON THE ADDRESS (2026-11-24): `/agents?draft=<text>` opens a blank conversation with that
// text in its composer, unsent. The word says what the window arrived with, not where it is, so it is taken off the
// address once read, as the rail's word is (local/railArrival.ts). Nothing here sends anything: an agent on this
// computer is started only by the reader's own Send.

const DRAFT = `draft`;

/** The text an arrival's route carries for the composer; none for an absent, bare or empty word. Pure. */
export const arrivingDraft = (query: LocationQuery): string | undefined => {
    const [word] = [query[DRAFT]].flat();
    return word === undefined || word === null || word === `` ? undefined : word;
};

/** The route's query with the draft's word taken off. Pure. */
export const withoutDraft = (query: LocationQuery): LocationQuery => {
    const { [DRAFT]: _draft, ...rest } = query;
    return rest;
};
