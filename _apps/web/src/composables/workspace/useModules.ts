import type { WorkspaceModule, WorkspaceModules } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* Every repo's modules — the package dirs the review lists group changed files under (see the daemon's
 * workspace/modules.ts). One workspace-wide read shared through the query cache by both review surfaces, the
 * workspace Changes panel and the fleet's agent review.
 *
 * Held long: module layout changes when a package is added or renamed, which is rare next to a change list
 * that re-reads on every git action, and a review that re-fetched the package layout on each poll would be
 * paying a tree walk to be told the same thing. A package created mid-session is simply not a module until the
 * next read — its files group under the repo, which is what they did before it existed. */
const MODULES_STALE_MS = 5 * 60_000;

export function useModules() {
    const { query } = useSandboxQuery({
        queryKey: sandboxKey(`workspace`, `modules`),
        queryFn: () => sandboxJson<WorkspaceModules>(`/workspace/modules`),
        staleTime: MODULES_STALE_MS,
    });
    // Keyed by the {repo} id both panels already carry on every row, so a lookup is never a scan.
    const byRepo = computed<ReadonlyMap<string, readonly WorkspaceModule[]>>(
        () => new Map((query.data.value?.repos ?? []).map((entry) => [entry.repo, entry.modules])),
    );
    const modulesOf = (repo: string): readonly WorkspaceModule[] => byRepo.value.get(repo) ?? [];
    return { modulesOf };
}
