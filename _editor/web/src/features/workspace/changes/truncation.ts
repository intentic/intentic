import type { GitDiffSide, RepoChanges } from "@intentic/api-contract";

/* WHAT A REPO HAS PENDING THAT THE REVIEW IS NOT DRAWING.
 *
 * The daemon ships at most a few hundred rows per repo (git.routes' MAX_REPO_CHANGES): a cloned monorepo or a
 * directory overhaul runs to five and six figures, and every one of those rows would be validated on the
 * daemon's event loop, held in the browser and drawn as real DOM. So past the budget the lists arrive short and
 * the remainder arrives as counts, per side.
 *
 * Every count the panel shows adds them back, and that is not cosmetic. The verbs act on SCOPES the daemon
 * resolves for itself, so "Stage all" moves the whole side and a commit records the whole index however much of
 * it was listed; a readout built from `staged.length` alone would sit next to the Commit button reporting five
 * hundred over a click that is about to record five thousand. The rows are a sample. The numbers are not.
 *
 * One module for the arithmetic because three surfaces do it (the badge, the commit box, the cross-sandbox
 * ledger) and they must agree.
 */

export const truncatedOn = (repo: RepoChanges, side: GitDiffSide): number =>
    side === `staged` ? (repo.truncated?.staged ?? 0) : side === `unstaged` ? (repo.truncated?.unstaged ?? 0) : 0;

// Conflicts are never cut: they block every commit in the repo, so all of them reach the user.
export const truncatedTotal = (repo: RepoChanges): number => (repo.truncated?.staged ?? 0) + (repo.truncated?.unstaged ?? 0);

// One side's real length: the rows shipped for it plus the ones that did not fit.
export const sideTotal = (repo: RepoChanges, side: GitDiffSide, shown: number): number => shown + truncatedOn(repo, side);
