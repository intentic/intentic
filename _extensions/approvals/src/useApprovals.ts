import type { ApprovalsList, ApprovalSummary } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

// The sandbox's approvals queue (.intentic/config/approvals/): the agent creates items via its file tools, this is the
// owner's side. `save` upserts by id (approve/edit/retry are a re-post with one field changed); `remove` rejects. The
// manifest wires that directory to the name `approvals`, which the host's table of pushed reads turns into this read's
// key, so a mid-conversation proposal appears without a poll.

export const approvalsQuery = () => ({
    queryKey: host().sandbox.readKey(`approvals.list`),
    queryFn: (): Promise<ApprovalsList> => host().sandbox.rpc.approvals.list(),
});

export function useApprovals() {
    const api = host();
    const queryClient = useQueryClient();
    const spec = approvalsQuery();
    const { query, error } = api.sandbox.query(spec);
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: spec.queryKey });

    const save = useMutation({
        mutationFn: (approval: ApprovalSummary) => api.sandbox.rpc.approvals.upsert(approval),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => api.sandbox.rpc.approvals.remove({ id }),
        onSuccess: invalidate,
    });

    const approvals = computed<ApprovalSummary[]>(() => query.data.value?.approvals ?? []);
    const invalid = computed<string[]>(() => query.data.value?.invalid ?? []);

    return {
        approvals,
        invalid,
        error,
        isLoading: query.isLoading,
        save,
        remove,
    };
}
