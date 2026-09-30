import type { ApprovalsList, ApprovalSummary } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

// The sandbox's approvals queue (.intentic/config/approvals/): the agent creates items via its file tools, this is the
// owner's side. `save` upserts by id (approve/edit/retry are a re-post with one field changed); `remove` rejects. The
// manifest wires that directory straight to this query key, so a mid-conversation proposal appears without a poll.

export const approvalsQuery = () => ({
    queryKey: host().sandbox.key(`approvals`),
    queryFn: (): Promise<ApprovalsList> => host().sandbox.rpc.approvals.list(),
});

export function useApprovals() {
    const api = host();
    const queryClient = useQueryClient();
    const spec = approvalsQuery();
    const { data, error, isLoading } = useQuery({
        ...spec,
        enabled: computed(() => api.sandbox.reachable()),
    });
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: spec.queryKey });

    const save = useMutation({
        mutationFn: (approval: ApprovalSummary) => api.sandbox.rpc.approvals.upsert(approval),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => api.sandbox.rpc.approvals.remove({ id }),
        onSuccess: invalidate,
    });

    const approvals = computed<ApprovalSummary[]>(() => data.value?.approvals ?? []);
    const invalid = computed<string[]>(() => data.value?.invalid ?? []);

    return {
        approvals,
        invalid,
        error: computed(() => error.value?.message),
        isLoading,
        save,
        remove,
    };
}
