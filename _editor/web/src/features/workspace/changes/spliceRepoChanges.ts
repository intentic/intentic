import type { CommitResult, GitChangesResponse } from "@intentic/api-contract";

// Folds a commit's one-repo answer into the cached review, avoiding a workspace-wide rescan.
// Pure and in its own module (not inside useChanges) since a merge rule this important is worth stating alone.
export const spliceRepoChanges = (held: GitChangesResponse, repo: string, result: CommitResult): GitChangesResponse => {
    // Bound once so TypeScript narrows it in the branches below; a property access would re-widen each time.
    const scanned = result.changes;
    // Absent drops the repo; present replaces in place to keep order; an uncached repo is appended, not dropped.
    const repos =
        scanned === undefined
            ? held.repos.filter((entry) => entry.repo !== repo)
            : held.repos.some((entry) => entry.repo === repo)
              ? held.repos.map((entry) => (entry.repo === repo ? scanned : entry))
              : [...held.repos, scanned];
    // Merged, not replaced: the answer only names the one scanned repo's agents; others would lose their titles.
    const originAgents = { ...held.originAgents, ...result.originAgents };
    // Everything else (e.g. `committing`) is left as-is; it describes other repos and updates on the next response.
    return { ...held, repos, ...(Object.keys(originAgents).length > 0 ? { originAgents } : {}) };
};
