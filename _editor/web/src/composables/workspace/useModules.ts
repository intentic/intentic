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
 * paying a tree walk to be told the same thing.
 *
 * Rare is not never, so the hold is ended by a PUSH rather than left to expire: a manifest landing on disk
 * invalidates this query (useWorkspaceLive), and the layout is re-read once. That push is what makes a package
 * created mid-session group under its own name straight away. Waiting out the hold instead was wrong at the one
 * moment the panel had most to say — a new package's files are ALL changes, so every one of them sat in the
 * repo's unclaimed bucket, and under a named bucket a row is drawn as its bare filename, so the list said
 * "package.json, index.ts, README.md, loose in this repo" about a package that plainly existed. */
const MODULES_STALE_MS = 5 * 60_000;

// Named for the background loader (composables/prefetch): both review surfaces group their rows by this, so
// having it early is the difference between a review that groups on arrival and one that regroups a beat later.
export const modulesKey = (): unknown[] => sandboxKey(`workspace`, `modules`);
export const fetchModules = (): Promise<WorkspaceModules> => sandboxJson<WorkspaceModules>(`/workspace/modules`);

export function useModules() {
    const { query } = useSandboxQuery({
        queryKey: modulesKey(),
        queryFn: fetchModules,
        staleTime: MODULES_STALE_MS,
    });
    // Keyed by the {repo} id both panels already carry on every row, so a lookup is never a scan.
    const byRepo = computed<ReadonlyMap<string, readonly WorkspaceModule[]>>(
        () => new Map((query.data.value?.repos ?? []).map((entry) => [entry.repo, entry.modules])),
    );
    const modulesOf = (repo: string): readonly WorkspaceModule[] => byRepo.value.get(repo) ?? [];
    return { modulesOf };
}
