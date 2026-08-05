import type { GitDiffSide } from "@intentic-app/api-contract";
import type { ChangeStatus } from "@intentic/extension-api";

/* WHERE A BINARY DIFF'S BYTES COME FROM. The daemon's file-diff routes ship text and can only FLAG an image
 * (`binary: true`), so the picture itself is fetched separately from /diff/raw — one request per side, the
 * daemon resolving the rev-specs from the same identifiers the JSON diff was asked for.
 *
 * Built here rather than in each panel because there are three diff sources in this app and one route: a review
 * surface that spelled its query differently would fail as a 400 nobody could trace back to it. Each panel names
 * its source and hands over the identifiers it already holds. The route serves a `commit` source too — that one
 * belongs to ext-git-history, which spells its own two URLs against the same daemon contract.
 *
 * WHICH SIDES EXIST is read off the row's status, not the response — a binary diff ships no `before`/`after`
 * text to infer it from, and git's status letter is the more direct answer anyway: an added file has no before,
 * a deleted one no after. A rename has neither problem and one of its own: its before side sits at the OLD
 * path, and none of the daemon's file diffs pair two different paths across the two sides (the text diff of a
 * rename is equally one-sided), so there is nothing to fetch for it. */

export type DiffRawSource =
    // Uncommitted work in a workspace repo — the Changes panel. `side` is the row's git side, because a
    // partially staged file's two rows are two different diffs.
    | { readonly source: "working"; readonly repo: string; readonly side: GitDiffSide }
    // One agent's work vs the base its review is listed against.
    | { readonly source: "agent"; readonly agent: string; readonly repo: string }
    // A checkpoint in the timeline, vs the previous VISIBLE checkpoint.
    | { readonly source: "checkpoint"; readonly snapshot: string; readonly scope: string };

const sideUrl = (source: DiffRawSource, path: string, which: "before" | "after"): string =>
    `/diff/raw?${new URLSearchParams({ ...source, path, which }).toString()}`;

// The two URLs a diff tab carries for a binary file. An omitted key means that side does not exist — the viewer
// then gives the one that does the whole pane instead of drawing an empty half next to it.
export const diffRawUrls = (source: DiffRawSource, path: string, status: ChangeStatus): { beforeRaw?: string; afterRaw?: string } => ({
    ...(status === `added` || status === `renamed` ? {} : { beforeRaw: sideUrl(source, path, `before`) }),
    ...(status === `deleted` ? {} : { afterRaw: sideUrl(source, path, `after`) }),
});
