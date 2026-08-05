/* WHAT AN EXTENSION HANDS THE HOST TO OPEN A DIFF — the argument to `api.workspace.openDiff`.
 *
 * A diff belongs in the editor area beside the files it is about, in the same tab strip as everything else the
 * user has open. That strip is the host's, so an extension that has computed a before/after pair has nowhere to
 * put it: a view renders inside its own frame, and a document provider inside its own tab. This is the way out,
 * and it is the whole shape of the contribution — the extension says what changed, the host owns the tab, the
 * viewer, the close orchestration and the dirty-buffer bookkeeping.
 *
 * It lives in the PUBLIC api package rather than in the app because the app is downstream of it: the workspace's
 * own review surfaces build the identical payload, and having two spellings of it is how the two would drift. */

// Git's vocabulary for what happened to a file. "conflicted" is git's unmerged state (`U`) and is not a kind of
// modification — there is no stage 0 for such a path, so nothing a commit could record. The host renders each of
// these as its own letter and colour.
export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "type-changed" | "conflicted";

/* A binary diff ships no text, so its two sides ride the payload as daemon URLs its BYTES are fetched from
 * rather than as content. An absent side means that side does not exist — an added file has no before, a deleted
 * one no after — and the viewer then gives the side that does exist the whole pane instead of drawing an empty
 * half beside it. */
export interface DiffRawSides {
    readonly beforeRaw?: string;
    readonly afterRaw?: string;
}

export interface DiffPayload extends DiffRawSides {
    /* The diff SOURCE's identity — a commit sha, a snapshot id, `working:<repo>`. Together with `scope` and
     * `path` it is the tab's identity, so re-opening the same file at the same commit focuses the tab that is
     * already open rather than stacking a second copy of it. Pick something stable and collision-free; prefixing
     * with the extension's own id is the safe habit. */
    readonly key: string;
    // Which repo (or snapshot scope) the path is relative to — the other half of the tab identity.
    readonly scope: string;
    // The tab's label. Short: the strip is narrow, and "file.ts @ a1b2c3d" reads better than a full path.
    readonly label: string;
    readonly status: ChangeStatus;
    readonly path: string;
    // The two sides as text. Absent where the side does not exist, or where the content is binary/oversized —
    // `binary` and `truncated` are what the viewer renders instead of an empty pane.
    readonly before?: string;
    readonly after?: string;
    readonly binary?: boolean;
    readonly truncated?: boolean;
    // What the row that opened this diff already knew about its size, carried onto the tab's toolbar. Absent
    // where the source has no numstat to give (a binary file, a change list without line counts) — the toolbar
    // then renders nothing rather than a zero.
    readonly additions?: number;
    readonly deletions?: number;
}
