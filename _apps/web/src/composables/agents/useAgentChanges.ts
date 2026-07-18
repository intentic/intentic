import type { FileDiffResponse, GitChangesResponse, RepoChanges } from "@intentic-app/api-contract";
import type { LandResult } from "@intentic/sandbox-contract";
import { computed, ref, type Ref } from "vue";
import { queryClient } from "../queryPersistence";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { useAsyncAction } from "../useAsyncAction";

/* Per-agent isolated review — useChanges' shape bound to one conversation's worktree: the diff is the
 * worktree's cumulative delta vs its recorded bases (GET /agents/{id}/diff, the same GitChanges wire shape),
 * and the actions are land (merge into the main tree) and discard (drop worktree + branch + registry entry)
 * instead of commit/discard. Parameterized by agent id — each review panel instance owns its own query. */

export function useAgentChanges(agentId: Ref<string>) {
    const { query, error } = useSandboxQuery({
        queryKey: computed(() => sandboxKey(`agents`, agentId.value, `diff`)),
        queryFn: () => sandboxJson<GitChangesResponse>(`/agents/${encodeURIComponent(agentId.value)}/diff`),
    });

    const repos = computed<readonly RepoChanges[]>(() => query.data.value?.repos ?? []);
    const count = computed(() => repos.value.reduce((total, repo) => total + repo.changes.length, 0));

    const { busy: actionBusy, error: actionError, run } = useAsyncAction();
    // The conflicts of the last land attempt, for the conflict panel; cleared by a clean land or discard.
    const conflicts = ref<LandResult[`conflicts`]>(undefined);

    const fileDiff = (repo: string, path: string): Promise<FileDiffResponse> =>
        sandboxJson<FileDiffResponse>(
            `/agents/${encodeURIComponent(agentId.value)}/${encodeURIComponent(repo)}/file-diff?path=${encodeURIComponent(path)}`,
        );

    // After a land or discard the agent's diff changed AND the landed work now shows in the MAIN review +
    // history — invalidate all three so every surface converges.
    const invalidateAfterAction = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey: sandboxKey(`agents`, agentId.value, `diff`) });
        await queryClient.invalidateQueries({ queryKey: [`git`, `changes`] });
        await queryClient.invalidateQueries({ queryKey: [`history`, `snapshots`] });
    };

    // Land: merge the worktree branches into the main tree. A partial result reports per-repo conflicts —
    // the worktree keeps everything, so the user can resolve (main-side), discard, or keep working.
    const land = (): Promise<void> =>
        run(async () => {
            const result = await sandboxJson<LandResult>(`/agents/${encodeURIComponent(agentId.value)}/land`, { method: `POST` });
            conflicts.value = result.conflicts;
            await invalidateAfterAction();
        }, `Land failed.`);

    // Discard: drop the worktrees, the agent/<id> branches, and the registry entry. Irreversible.
    const discard = (): Promise<void> =>
        run(async () => {
            await sandboxJson(`/agents/${encodeURIComponent(agentId.value)}/discard`, { method: `POST` });
            conflicts.value = undefined;
            await invalidateAfterAction();
        }, `Discard failed.`);

    return {
        repos,
        count,
        loading: query.isFetching,
        error,
        refresh: query.refetch,
        fileDiff,
        land,
        discard,
        conflicts,
        actionBusy,
        actionError,
    };
}
