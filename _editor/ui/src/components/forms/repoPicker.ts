import type { IconName } from "../../icons/iconSets.js";

// RepoPicker's "All repositories" row, kept in a plain module: a caller builds it in a computed from its own report,
// and importing a type through a .vue file would drag the whole component graph with it.

/** The leading "All repositories" row. It has no value of its own: it is the state an undefined model means. */
export interface RepoPickerAll {
    /** Defaults to the folder glyph the repository rows usually wear. */
    readonly icon?: IconName;
    /** The workspace-wide total, worded by the caller ("3 due", "nothing failing"); omitted prints nothing. */
    readonly description?: string;
}
