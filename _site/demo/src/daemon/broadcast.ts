import { listeners } from "./board/roster";

// The two pushes the daemon sends when something outside the board moves, sent to every open /events stream as
// roster.ts sends the board. A write under a watched path is a `workspaceChanged`, which the editor maps to the reads
// that path feeds (workspace-state.ts); a process coming up or going down is a `runtimeChanged` for its domains.

export const pushWorkspaceChanged = (...paths: string[]): void => {
    for (const listener of listeners) {
        listener({ kind: `workspaceChanged`, paths });
    }
};

export const pushRuntimeChanged = (...domains: string[]): void => {
    for (const listener of listeners) {
        listener({ kind: `runtimeChanged`, domains });
    }
};
