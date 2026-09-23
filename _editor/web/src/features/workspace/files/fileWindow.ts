import type { WorkspaceFileResponse } from "@intentic/api-contract";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { workspaceAgent } from "../health/workspaceScope";

// The only way the browser reads workspace text: a bounded window, never the whole file. The daemon clamps `limit` to
// its own MAX_TEXT_BYTES and reports the range it served, so this is a request, not a guarantee. Larger than
// TEXT_EDIT_MAX_BYTES, so anything editable arrives in one window.
export const FILE_WINDOW_BYTES = 4 * 1024 * 1024;

// Negative `offset` counts from the file's end (what a tail wants, without a stale stat). A missing path resolves
// `present: false`; only a refused or unreachable read throws.
export const readFileWindow = (path: string, opts?: { offset?: number; limit?: number; signal?: AbortSignal }): Promise<WorkspaceFileResponse> =>
    sandboxRpc.workspace.file(
        { path, limit: opts?.limit ?? FILE_WINDOW_BYTES, offset: opts?.offset, agent: workspaceAgent.value },
        { signal: opts?.signal },
    );
