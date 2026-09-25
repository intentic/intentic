import { relative, sep } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import { isNewer, isReportedManifest, type ManifestProblem, type ManifestProblemReport } from "@intentic/sandbox-contract";
import { version } from "../version.js";
import { newestRunVersion } from "./newest-run.js";

// Records what a manifest read under `<workspace>/.intentic/` could not parse or validate, so a browser can show it
// instead of the daemon failing silently (all-defaults, a dropped key, a skipped entry). Replaced per file on every
// read, so fixing the file clears the notice on its own.

// Re-exported from the contract, not redeclared: these are wire types the browser renders, documented there.
export type { ManifestProblem, ManifestProblemReport };

// Keyed by the file's absolute path, as jsonFile holds it; made workspace-relative on the way out.
const byPath = new Map<string, readonly ManifestProblem[]>();

// Called on every manifest read, healthy or not; always calling is what makes the registry self-clearing, since a
// healthy read erases the previous complaint.
export const recordManifestProblems = (path: string, problems: readonly ManifestProblem[]): void => {
    if (problems.length === 0) {
        byPath.delete(path);
        return;
    }
    byPath.set(path, problems);
};

// Manifests with a problem a person can act on, sorted by path for a stable poll; recording is indiscriminate, the
// audience filter (isReportedManifest) happens here where the path is workspace-relative.
// Must match the schema-rejection detail json-file.ts writes; a reword there has to move this constant too.
const SCHEMA_REJECTED = "the file does not match what this build expects";

// A schema rejection looks identical whether hand-mangled or written by a newer, rolled-back build. If the workspace's
// stamp says newer, the report says so instead of implying damage; nothing reads the file differently.
export const withSkewHint = (problems: readonly ManifestProblem[], running: string, newest: string | undefined): ManifestProblem[] =>
    problems.map((problem) => {
        if (newest === undefined || !isNewer(newest, running)) {
            return problem;
        }
        if (problem.kind === "unreadable" && problem.detail === SCHEMA_REJECTED) {
            return {
                ...problem,
                detail: `it was written by intentic ${newest}, newer than this sandbox (${running})`,
                // The file is probably fine; editing it to match an older build is how a good config breaks by hand.
                fix: `Update the sandbox — the file itself is probably fine.`,
            };
        }
        if (problem.kind === "unknownKey") {
            // A key a newer build added, kept on every write since passthrough (passthrough.ts): not a typo to correct,
            // so no "did you mean" guess, which would invite renaming it into something this build reads wrongly.
            return {
                kind: problem.kind,
                detail: problem.detail,
                fix: `Probably from intentic ${newest}, newer than this sandbox (${running}): it is kept as it is, and read again once you update.`,
            };
        }
        return problem;
    });

// How a report names a file: workspace-relative, or, for one on the daemon's volume, the absolute path it has there
// (`/history/conversations.db`) whatever root this daemon was started with.
const reportedPath = (root: string, historyRoot: string | undefined, path: string): string =>
    historyRoot !== undefined && path.startsWith(`${historyRoot}${sep}`)
        ? `${HISTORY_ROOT}/${relative(historyRoot, path).split(sep).join("/")}`
        : relative(root, path);

export const manifestProblems = (root: string, historyRoot?: string): ManifestProblemReport[] =>
    [...byPath.entries()]
        .map(([path, problems]) => ({ rel: reportedPath(root, historyRoot, path), problems }))
        .filter(({ rel }) => isReportedManifest(rel))
        // Copied on the way out, never by reference, since this is the registry's own array.
        .map(({ rel, problems }) => ({ path: rel, problems: withSkewHint(problems, version, newestRunVersion()) }))
        .toSorted((a, b) => a.path.localeCompare(b.path));

// What the last read of one file recorded, whether or not the file is one the browser is shown.
export const recordedProblems = (path: string): readonly ManifestProblem[] => byPath.get(path) ?? [];

// Test seam: resets the module-level registry between suites.
export const clearManifestProblems = (): void => byPath.clear();
