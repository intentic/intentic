import type { IconName } from "../../icons/iconSets.js";

// RepoRail's row model, kept in a plain module: a caller builds these in a computed from its own report, and importing
// a type through a .vue file would drag the whole component graph with it.

export interface RepoRailRow {
    /** What the rail models when this row is picked, the repository's identifier. */
    readonly value: string;
    /** What to call it. */
    readonly label: string;
    readonly icon: IconName;
    /** The row's one number, already worded by the caller; empty prints nothing, since a zero would be a claim. */
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
    /** Omitted with nothing to explain: a heading over a rail's only group names a distinction nobody's making. */
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
