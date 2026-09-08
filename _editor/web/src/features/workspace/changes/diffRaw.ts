import type { GitDiffSide } from "@intentic/api-contract";
import type { ChangeStatus } from "@intentic/extension-api";

// Binary diff bytes come from a separate /diff/raw request per side; built once so all diff sources query it
// identically. Sides are inferred from status, not the response: added has no before, deleted no after, and a
// rename's before is at the old path, so nothing is fetched for it.

export type DiffRawSource =
    // Uncommitted work in a workspace repo; `side` is the git side, since a half-staged file is two different diffs.
    | { readonly source: "working"; readonly repo: string; readonly side: GitDiffSide }
    // One agent's work vs the base its review is listed against.
    | { readonly source: "agent"; readonly agent: string; readonly repo: string }
    // A checkpoint in the timeline, vs the previous visible checkpoint.
    | { readonly source: "checkpoint"; readonly snapshot: string; readonly scope: string };

const sideUrl = (source: DiffRawSource, path: string, which: "before" | "after"): string =>
    `/diff/raw?${new URLSearchParams({ ...source, path, which }).toString()}`;

// The two URLs for a binary file's sides; an omitted key means that side doesn't exist, so the viewer gives the
// other the whole pane.
export const diffRawUrls = (source: DiffRawSource, path: string, status: ChangeStatus): { beforeRaw?: string; afterRaw?: string } => ({
    ...(status === `added` || status === `renamed` ? {} : { beforeRaw: sideUrl(source, path, `before`) }),
    ...(status === `deleted` ? {} : { afterRaw: sideUrl(source, path, `after`) }),
});
