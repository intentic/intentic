import type { FigureAccent } from "../markdown/figures.js";

/* <NavRail>'s group model, in a plain module for the same reason <Picker>'s lives in picker.ts: a caller builds
 * these out of its own data in a computed, and a type it has to reach through a .vue file is a type it cannot
 * import without the component graph coming with it. */
export interface NavGroup<T> {
    /** Stable key for :key, a label is optional, and two groups may legitimately share one. */
    readonly key: string;
    /** Omitted for a single unlabelled run of rows: with one group every row belongs to it, and the heading is
     *  then a line of chrome above the content. */
    readonly label?: string;
    readonly count?: number;
    /** Paints the heading's leading dot from the chart palette, the documentation map's component colours. */
    readonly accent?: FigureAccent;
    readonly items: readonly T[];
}
