import { Frames } from "@intentic/contract-serve";
import type { WorkspaceSearchFrame, WorkspaceSearchResult } from "@intentic/sandbox-contract/schemas/workspace/workspace-search";

// A text search streamed the way the daemon's ripgrep pass streams it: the files with a match sent a few at a time as
// they are found, then the finished first page, which replaces them. Paced so the results are seen arriving.

const BATCH = 3;
const STEP_MS = 140;

export const streamSearch = (result: WorkspaceSearchResult): Frames<WorkspaceSearchFrame> =>
    new Frames((sink) => {
        let sent = 0;
        const timer = setInterval(() => {
            const groups = result.groups.slice(sent, sent + BATCH);
            if (groups.length > 0) {
                sink.emit({ kind: `groups`, groups });
                sent += groups.length;
                return;
            }
            sink.emit({ kind: `done`, result });
            sink.close();
        }, STEP_MS);
        return () => clearInterval(timer);
    });
