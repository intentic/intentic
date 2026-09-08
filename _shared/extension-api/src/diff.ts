import type { PartialFileDiff } from "@intentic/sandbox-contract";

// The argument to `api.workspace.openDiff`: the extension says what changed, the host owns the tab, viewer and
// dirty-buffer bookkeeping. Lives in the public api package because the app's own review surfaces build the identical
// payload.

// Git's vocabulary for what happened to a file; the host renders each as its own letter and colour. "conflicted" is
// git's unmerged state (`U`), not a kind of modification.
export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "type-changed" | "conflicted";

// A binary diff ships its two sides as daemon URLs to fetch bytes from, not as content. An absent side means that side
// does not exist; the viewer gives the pane entirely to the side that does.
export interface DiffRawSides {
    readonly beforeRaw?: string;
    readonly afterRaw?: string;
}

export interface DiffPayload extends DiffRawSides {
    // Identity of the diff source (commit sha, snapshot id, `working:<repo>`); with `scope`/`path` it is the tab's
    // identity, so a reopen focuses it.
    readonly key: string;
    // Which repo (or snapshot scope) the path is relative to, the other half of the tab identity.
    readonly scope: string;
    // The tab's label; keep it short (e.g. "file.ts @ a1b2c3d"), the strip is narrow.
    readonly label: string;
    readonly status: ChangeStatus;
    readonly path: string;
    // The two sides as text; absent when a side doesn't exist or is binary/oversized (see `binary`/`partial`).
    readonly before?: string;
    readonly after?: string;
    readonly binary?: boolean;
    // A big file's changed regions (a unified patch) plus both sizes; set this instead of before/after.
    readonly partial?: PartialFileDiff;
    // Size already known by the row that opened this, shown on the tab's toolbar; absent renders nothing, not zero.
    readonly additions?: number;
    readonly deletions?: number;
    // Opens the tab immediately and fills content later via `workspace.fillDiff`; absent means the payload is the
    // content.
    readonly pending?: boolean;
    // A peek, not an open: reuses the strip's one transient tab slot instead of pinning a new one; absent keeps it.
    readonly preview?: boolean;
}
