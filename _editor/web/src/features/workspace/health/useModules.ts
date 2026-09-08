import type { WorkspaceModule, WorkspaceModules } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { WORKSPACE_MODULES } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";

// Every repo's modules as /work has them (main tree only); the fleet's agent review reads its own worktree
// layout instead. Held long, since layout rarely changes, but invalidated by a push rather than time, so a
// package created mid-session groups under its own name immediately instead of showing as loose files.
const MODULES_STALE_MS = 5 * 60_000;

// Named for the background loader (composables/prefetch); having this key early means the Changes panel
// groups on arrival, not a beat later.
export const modulesKey = (): unknown[] => WORKSPACE_MODULES.of();
export const fetchModules = (): Promise<WorkspaceModules> => sandboxJson<WorkspaceModules>(`/workspace/modules`);

export function useModules() {
    const { query } = useSandboxQuery({
        queryKey: modulesKey(),
        queryFn: fetchModules,
        staleTime: MODULES_STALE_MS,
    });
    // Keyed by the {repo} id every row already carries, so a lookup is never a scan.
    const byRepo = computed<ReadonlyMap<string, readonly WorkspaceModule[]>>(
        () => new Map((query.data.value?.repos ?? []).map((entry) => [entry.repo, entry.modules])),
    );
    const modulesOf = (repo: string): readonly WorkspaceModule[] => byRepo.value.get(repo) ?? [];
    return { modulesOf };
}
