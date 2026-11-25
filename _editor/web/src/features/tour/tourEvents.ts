import { track } from "../../app/analytics";
import type { EventProperties } from "../../app/analyticsEvents/eventRegistry";

// What the checklist tells the product's own analytics, so whether it teaches is measured rather than guessed: a hint
// seen, a step finished while the list was up, a step passed over, the list put away. Step names and counts only; never
// a path, a title or anything the reader typed.

export type TourEvent = `tour_step_shown` | `tour_step_done` | `tour_step_skipped` | `tour_hidden`;

export const trackTour = <E extends TourEvent>(event: E, properties: EventProperties<E>): void => {
    track(event, properties);
};
