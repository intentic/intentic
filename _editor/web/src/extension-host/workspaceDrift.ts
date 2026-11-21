import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import { codeRevisionOf } from "../features/extensions/codeRevision";

// The workspace's own extensions a list says run, each by its code revision: what a land, or an edit made in place,
// moves. Installed ones move only by a press that reloads the host itself, or offer "Reload now" (useExtensionList.ts).
export const runningWorkspace = (summaries: readonly ExtensionSummary[]): ReadonlyMap<string, string> =>
    new Map(summaries.filter((summary) => summary.source === `workspace` && summary.enabled).map((summary) => [summary.id, codeRevisionOf(summary)]));

// Whether a list names the workspace's own extensions differently from what the host loaded: one appeared (a land turned
// it on), went, was switched, or its code moved.
export const workspaceDrifted = (loaded: ReadonlyMap<string, string>, listed: readonly ExtensionSummary[]): boolean => {
    const running = runningWorkspace(listed);
    return running.size !== loaded.size || [...running].some(([id, revision]) => loaded.get(id) !== revision);
};
