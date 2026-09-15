import type { GitReposResponse } from "@intentic/api-contract";
import { computed } from "vue";
import { projectScope, withinScope } from "../../../app/projectScope";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { GIT_REPOS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";

/* Every real git repo under /work, "root" (the /work repo itself, implicit) plus each discovered nested repo, as root-relative dir ids. */

export function useRepos() {
    const { query } = useSandboxQuery({
        queryKey: GIT_REPOS.of(),
        queryFn: () => sandboxJson<GitReposResponse>(`/git/repos`),
    });
    const all = computed<readonly string[]>(() => query.data.value?.repos ?? []);
    // The open project's repositories only (app/projectScope.ts), like every other repository-keyed source.
    const nested = computed<readonly string[]>(() => all.value.filter(withinScope));
    // The dir ids that are repos; a changed file's (root-relative) path is attributed to one by testing this set.
    const repoDirs = computed<ReadonlySet<string>>(() => new Set(nested.value));
    // "root" first, then the nested repos, the graph switcher's option list; the workspace's own repository is outside
    // every project, so it is offered only when none is open.
    const options = computed<readonly string[]>(() => (projectScope.value === undefined ? [`root`, ...nested.value] : nested.value));
    return { nested, all, repoDirs, options, refresh: query.refetch };
}
