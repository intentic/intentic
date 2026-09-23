import { join } from "node:path";
import type { WorkspaceStatePath } from "@intentic/sandbox-contract";

// Builds an absolute path for a declared WorkspaceStatePath; only a table-declared path is nameable (literal union).
// tail extends a directory entry (the table declares the prefix); trailing slashes are dropped.
export const statePath = (root: string, path: WorkspaceStatePath, ...tail: readonly string[]): string => join(root, stateRelPath(path, ...tail));

// Same spelling without root, for sites that compare rather than open (watcher prefix, git exclude, storedAt, prompts).
// Forward-slash, matching the workspaceChanged path space; trailing slash dropped as above.
export const stateRelPath = (path: WorkspaceStatePath, ...tail: readonly string[]): string => [path.replace(/\/$/, ""), ...tail].join("/");
