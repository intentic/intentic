import type { WorkspaceFileResponse } from "@intentic-app/api-contract";
import { sandboxJson } from "../sandbox/sandboxClient";
import { scopeQuery } from "./workspaceScope";

/* The one way the browser reads workspace TEXT: a bounded window, never "the file". Every reader — the file
 * viewer's first read, the windowed viewer's paging, a tail-follow's appended bytes — asks through here, so
 * none of them can be the one that pulls a 500MB log into a JSON response.
 *
 * The daemon clamps `limit` to its own MAX_TEXT_BYTES and answers with the range it actually served, so the
 * number below is a request, not a guarantee — if the two ever drift, the daemon's cap is the one that holds.
 * It is deliberately larger than TEXT_EDIT_MAX_BYTES: everything small enough to edit arrives in one window. */
export const FILE_WINDOW_BYTES = 4 * 1024 * 1024;

// `offset` counts from the file's start, or from its END when negative — which is what a tail wants, and the
// only way to ask for one without a stat that is already stale by the time the read runs.
//
// The read carries the view's current scope (workspaceScope), so every reader is answered from the tree the
// user is actually looking at without any of them having to know that more than one exists. The response's
// `shared` says which tree answered — a conversation's checkout is not a superset of /work, so a scoped read
// can legitimately come back from the shared one.
//
// A path with NOTHING at it resolves (`present: false`) rather than rejecting: half the reads in the app are
// "read it if it is there", and a rejection made the browser log a failed request for each one. Only a refused
// or unreachable read throws now, which is what every caller's error branch is actually about.
export const readFileWindow = (path: string, opts?: { offset?: number; limit?: number; signal?: AbortSignal }): Promise<WorkspaceFileResponse> => {
    const query = scopeQuery(new URLSearchParams({ path, limit: String(opts?.limit ?? FILE_WINDOW_BYTES) }));
    if (opts?.offset !== undefined) {
        query.set(`offset`, String(opts.offset));
    }
    return sandboxJson<WorkspaceFileResponse>(`/workspace/file?${query.toString()}`, { signal: opts?.signal });
};
