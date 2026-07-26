import type { AgentChangesResponse, AgentRepoChanges, FileDiffResponse } from "@intentic-app/api-contract";
import type { LandResult } from "@intentic/sandbox-contract";
import { computed, ref, type Ref } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { useAsyncAction } from "../useAsyncAction";
import { discardAgent, invalidateAgentAction, landAgent } from "./agentActions";

/* Per-agent isolated review — useChanges' shape bound to one conversation's worktree: the diff is the
 * worktree's cumulative delta vs its recorded bases (GET /agents/{id}/diff, the AgentChanges wire shape — one
 * flat set per repo, with no staged/unstaged split, because a worktree the user never checks out has no index
 * they could stage into), and the actions are land (merge into the main tree) and discard (drop worktree +
 * branch + registry entry) instead of commit/discard. Parameterized by agent id — each review panel instance owns its own query.
 *
 * The mutations themselves live in agentActions (the board's drag-to-act drops fire the same ones); what this
 * adds is the panel's own busy/error reporting and the last land attempt's conflicts. */

export function useAgentChanges(agentId: Ref<string>) {
    const { query, error } = useSandboxQuery({
        queryKey: computed(() => sandboxKey(`agents`, agentId.value, `diff`)),
        queryFn: () => sandboxJson<AgentChangesResponse>(`/agents/${encodeURIComponent(agentId.value)}/diff`),
    });

    const repos = computed<readonly AgentRepoChanges[]>(() => query.data.value?.repos ?? []);
    const count = computed(() => repos.value.reduce((total, repo) => total + repo.changes.length, 0));

    const { busy: actionBusy, error: actionError, run } = useAsyncAction();
    // The conflicts of the last land attempt, for the conflict panel; cleared by a clean land or discard.
    const conflicts = ref<LandResult[`conflicts`]>(undefined);

    const fileDiff = (repo: string, path: string): Promise<FileDiffResponse> =>
        sandboxJson<FileDiffResponse>(
            `/agents/${encodeURIComponent(agentId.value)}/${encodeURIComponent(repo)}/file-diff?path=${encodeURIComponent(path)}`,
        );

    const land = (): Promise<void> =>
        run(async () => {
            conflicts.value = (await landAgent(agentId.value)).conflicts;
            await invalidateAgentAction(agentId.value);
        }, `Land failed.`);

    const discard = (): Promise<void> =>
        run(async () => {
            await discardAgent(agentId.value);
            conflicts.value = undefined;
            await invalidateAgentAction(agentId.value);
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
