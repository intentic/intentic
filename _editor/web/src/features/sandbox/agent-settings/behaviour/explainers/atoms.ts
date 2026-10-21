import { toneTint } from "@intentic/ui";

// The pieces every Tools explainer draws with, so six diagrams read as one visual language: a box is a thing (a
// command, a file, the agent), a bar is an amount, an arrow is what happens next.

/** A thing in a diagram: a step, a file, a machine. */
export const BOX = `inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-line bg-card px-1.5 py-0.5 text-2xs text-content`;
/** The same box, for the step a mechanism removes or makes cheaper. */
export const BOX_FADED = `inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-dashed border-line px-1.5 py-0.5 text-2xs text-subtle`;
/** A box that is the outcome a reader wants. */
export const BOX_GOOD = toneTint(
    `success`,
    `strong`,
    `inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-2xs text-content`,
);
/** A larger area in the same tone: what the agent is left reading, the share kept for you. */
export const AREA_GOOD = toneTint(`success`, `strong`, `border text-content`);
/** A lane's name, above or before what it draws. */
export const LANE = `text-2xs font-medium text-subtle`;
/** An arrow between steps. */
export const ARROW = `shrink-0 text-2xs text-subtle`;
/** One segment of a stacked bar; the caller gives it a width and a fill. */
export const SEGMENT = `flex h-5 min-w-0 items-center justify-center overflow-hidden rounded-sm px-1 text-[0.625rem] leading-none`;
