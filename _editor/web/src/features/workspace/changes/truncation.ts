import type { GitDiffSide, RepoChanges } from "@intentic/api-contract";

// The daemon caps rows per repo (MAX_REPO_CHANGES); a repo past that ships a short list plus a per-side count.
// Verbs act on the daemon's full scope, not the shown rows, so every displayed count must add the truncated
// remainder back. One module for the arithmetic since three surfaces (badge, commit box, cross-sandbox ledger) must
// agree.

export const truncatedOn = (repo: RepoChanges, side: GitDiffSide): number =>
    side === `staged` ? (repo.truncated?.staged ?? 0) : side === `unstaged` ? (repo.truncated?.unstaged ?? 0) : 0;

// Conflicts aren't truncated — they block every commit, so all of them always reach the user.
export const truncatedTotal = (repo: RepoChanges): number => (repo.truncated?.staged ?? 0) + (repo.truncated?.unstaged ?? 0);

// One side's true count: the rows shipped plus however many didn't fit.
export const sideTotal = (repo: RepoChanges, side: GitDiffSide, shown: number): number => shown + truncatedOn(repo, side);
