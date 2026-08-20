import type { IconName } from "../icons/iconSets.js";

/* <RepoRail>'s row model, in a plain module for the same reason <NavRail>'s and <Picker>'s are: a caller builds
 * these out of its own report in a computed, and a type it has to reach through a .vue file is a type it cannot
 * import without the component graph coming with it. */

export interface RepoRailRow {
    /** What the rail models when this row is picked, the repository's identifier. */
    readonly value: string;
    /** What to call it. */
    readonly label: string;
    readonly icon: IconName;
    /** The row's ONE number, already worded by the caller. An empty string prints nothing, which is what a
     *  repository nobody has heard from wants: a zero there would be a claim about it. */
    readonly meta: string;
    /** Text colour for that number, how the second fact a row carries is said without a second number. */
    readonly tone?: string;
    /** Where the number is spelled out in full. A question asked of one row at a time. */
    readonly tooltip?: string;
    /** Monospace label, repository paths and other machine names. */
    readonly mono?: boolean;
}

export interface RepoRailGroup {
    /** Stable key for :key. */
    readonly key: string;
    /** Omitted for a run of rows that needs no explaining: a heading over the only group in a rail names a
     *  distinction nobody is making. */
    readonly label?: string;
    readonly rows: readonly RepoRailRow[];
}

/** The pinned "All repositories" row. It has no value, it is the state the rail returns to. */
export interface RepoRailAll {
    readonly icon: IconName;
    readonly meta: string;
    readonly tone?: string;
    readonly tooltip?: string;
}
