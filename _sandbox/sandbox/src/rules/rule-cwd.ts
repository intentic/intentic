import { join } from "node:path";
import type { Rule } from "@intentic/sandbox-contract";

// Where a rule's command runs. A rule naming a repository runs IN that repository, which is the difference between
// `cd intentic && pnpm verify:push` written into a command and `pnpm verify:push` aimed at a repository: the first is a
// workspace-wide rule wearing a disguise, and it is wrong for every other repository the workspace holds.
// `tree` is the tree the occasion is about — the workspace root for a push, an isolated turn's own worktree for a
// turn — so the same rule runs in the same relative place either way.
export const ruleCwd = (tree: string, rule: Rule): string => repoCwd(tree, rule.when?.repo);

// The same resolution for a repo id on its own, for callers that have the repo rather than the rule.
export const repoCwd = (tree: string, repo: string | undefined): string => (repo === undefined || repo === "root" ? tree : join(tree, repo));
