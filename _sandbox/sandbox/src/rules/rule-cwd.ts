import { join } from "node:path";

// Where a repository's check runs: IN that repository, so a check aimed at one (`pnpm lint`) needs no `cd` and runs in
// the same relative place in the workspace root and in an isolated turn's own worktree.
export const repoCwd = (tree: string, repo: string | undefined): string => (repo === undefined || repo === "root" ? tree : join(tree, repo));
