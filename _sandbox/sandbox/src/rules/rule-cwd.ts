import { join } from "node:path";

// Where a repository's check runs: IN that repository, so `pnpm verify:turn` aimed at one needs no `cd` and runs in the
// same relative place in the workspace root and in an isolated turn's own worktree.
export const repoCwd = (tree: string, repo: string | undefined): string => (repo === undefined || repo === "root" ? tree : join(tree, repo));
