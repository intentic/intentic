import type { GitReposResponse } from "@intentic-app/api-contract";
import { computed } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { GIT_REPOS } from "../queryKeys";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* Every real git repo under /work — "root" (the /work repo itself, implicit) plus each discovered nested repo,
 * as root-relative dir ids. Drives the file tree's per-repo git-history affordance and the graph's repo
 * switcher. Distinct from useChanges (which lists only repos WITH uncommitted work) — this lists them all. */

export function useRepos() {
    const { query } = useSandboxQuery({
        queryKey: GIT_REPOS.of(),
        queryFn: () => sandboxJson<GitReposResponse>(`/git/repos`),
    });
    const nested = computed<readonly string[]>(() => query.data.value?.repos ?? []);
    // The dir ids that are repos — the tree tests membership by a row's (root-relative) path against this set.
    const repoDirs = computed<ReadonlySet<string>>(() => new Set(nested.value));
    // "root" first, then the nested repos — the graph switcher's option list.
    const options = computed<readonly string[]>(() => [`root`, ...nested.value]);
    return { nested, repoDirs, options, refresh: query.refetch };
}
