import { SandboxHttpError } from "../sandboxHttpError";
import { folderSurface, staleDaemonReason } from "../useDaemonRoutes";

// A FOLDER ON THIS COMPUTER ANSWERS THE FEW ROUTES ITS HELLO LISTS, and no update brings it another (useDaemonRoutes.ts):
// a call to any other is refused here, unsent, by both clients (sandboxRpc.ts, sandboxRaw.ts), in the one sentence that
// names the gap. Marked as a refusal the editor foresaw (`predicted`), so the query cache neither logs it as a failure
// nor asks again (lib/queryPersistence.ts): its answer cannot change by asking.
//
// Until 2026-11-24 a procedure's call went out and came back 404, three times a read, and a raw route's threw a plain
// error the cache logged and retried. That was a handful of reads while a folder window drew only files; with the
// sandbox's own chat drawn there (local/agents/), every read one of its sandbox-only parts makes would have joined them.

/** The refusal for a call to `route` the active folder's sidecar does not serve; undefined when it serves it, or when a sandbox answers. */
export const folderRefusal = (route: string): SandboxHttpError | undefined => {
    if (!folderSurface.value) {
        return undefined;
    }
    const reason = staleDaemonReason(route);
    return reason === undefined ? undefined : new SandboxHttpError(404, reason, { predicted: true });
};
