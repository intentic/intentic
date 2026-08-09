import type { CommitResult, GitChangesResponse } from "@intentic-app/api-contract";

/* ONE REPO'S ROWS, REPLACED FROM THE ANSWER THAT MOVED THEM — the rule that lets a commit redraw the review
 * without re-reading the workspace.
 *
 * A commit answers with the repo it just wrote, scanned inside the same lock (see CommitResultSchema). Folding
 * that answer into the cached review set is what the panel does instead of the workspace-wide rescan it used to
 * fire the moment a commit returned: ~11 git spawns per repo, for every repo the commit never touched, on the
 * daemon's most contended path, while the user watched the rows they had just committed sit there. That read
 * WAS the "Commit takes five seconds" report — the commit itself is milliseconds of git.
 *
 * Pure, in its own module rather than inside useChanges, on outgoingWork's reasoning: the composable pulls the
 * chat singleton and the query client in with it, and a merge rule this load-bearing is worth stating alone. */
export const spliceRepoChanges = (held: GitChangesResponse, repo: string, result: CommitResult): GitChangesResponse => {
    // Bound before the branches so it narrows inside them — a property access re-widens on every read.
    const scanned = result.changes;
    /* Absent means the daemon applied its own inclusion rule and found nothing left to show, so the row goes.
     * Present replaces IN PLACE, keeping the list's order: the panel groups by repo, and a repo that jumped to
     * the end of the list after every commit would move rows the user is still reading.
     *
     * A repo the cache does not hold yet is APPENDED rather than dropped. A commit can leave work behind in a
     * repo the last scan had nothing to say about — an untracked file `commit -a` never sweeps, a branch that
     * only now has something to push — and swallowing that would hide it until some later scan surfaced it. */
    const repos =
        scanned === undefined
            ? held.repos.filter((entry) => entry.repo !== repo)
            : held.repos.some((entry) => entry.repo === repo)
              ? held.repos.map((entry) => (entry.repo === repo ? scanned : entry))
              : [...held.repos, scanned];
    // MERGED, never replaced: the answer names only the agents of the ONE repo it scanned, and every other
    // repo's rows still carry ids of their own that would lose their titles and fall back to "Agent 1a2b3c".
    const originAgents = { ...held.originAgents, ...result.originAgents };
    // Everything else the response carries is left as it was — `committing` above all, which is about the OTHER
    // repos still being recorded and is not this one commit's to answer for. It is the daemon's fact and the
    // next changes response is what updates it.
    return { ...held, repos, ...(Object.keys(originAgents).length > 0 ? { originAgents } : {}) };
};
