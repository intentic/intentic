import type { FigureAccent } from "../markdown/figures.js";

/* <BarChart>'s row model, in plain TypeScript beside the component the way picker.ts and dagLayout.ts sit
 * beside theirs. It lives here so a caller can BUILD its rows in a pure module — the Usage tab's projections
 * map ranked spend into these, and those projections have unit tests that must not boot a component graph. */
export interface BarItem {
    readonly label: string;
    // The tip label, when the raw number is not what a reader wants to see ("18.2k lines", "3 days", "$4.10").
    // Absent ⇒ the renderer prints the value, thousands-separated.
    readonly value: number;
    readonly display?: string;
    readonly accent?: FigureAccent;
    /* A distinct v-for identity, for the one caller whose labels can legitimately collide: a ranked cost list
       can hold a real agent named "other" beside the folded "other" bucket. Absent ⇒ the label is the key,
       which is true of every authored figure. */
    readonly key?: string;
    /* This row names a BUCKET, not a thing — the folded tail, or spend that carried no value for the dimension
       being ranked. Italic muted type, so it reads as a category among proper nouns without being demoted out
       of the ranking it genuinely belongs in. */
    readonly muted?: boolean;
}
