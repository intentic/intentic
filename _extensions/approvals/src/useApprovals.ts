import type { ApprovalsList, ApprovalSummary } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* The sandbox's approvals queue (.intentic/config/approvals/, one file per item), read/written via the daemon's
 * /approvals routes. The AGENT creates items with its file tools (taught by the daemon's approvals skill); this
 * is the OWNER's side, `save` upserts by id (approve/edit/retry are all a re-post with a field changed),
 * `remove` rejects. The daemon's executor re-arms itself on every write, so there's nothing to provision.
 *
 * The manifest's `contributes.files` entry points `.intentic/config/approvals/` at this query key, so the agent
 * dropping a proposal in mid-conversation is on screen without a poll. */

export const approvalsQuery = () => ({
    queryKey: host().sandbox.key(`approvals`),
    queryFn: (): Promise<ApprovalsList> => host().sandbox.rpc.approvals.list(),
});

// The split the badge and the mobile chip both need without mounting the view: what the queue OWES its owner.
// A proposal waiting for a yes, an item that failed, and a file the daemon could not read are the three states
// where nothing moves until the owner acts. Approved-and-scheduled goes ahead on its own and `done` is history:
// counting either gives a badge that never returns to zero, which is how a badge stops being read. `broken` is
// the subset that is wrong rather than merely waiting, enough to pick a tone without re-deriving the split.
export const owedOf = (list: ApprovalsList | undefined): { owed: number; broken: number } => {
    const approvals = list?.approvals ?? [];
    const broken = approvals.filter((item) => item.status === `failed`).length + (list?.invalid.length ?? 0);
    return { owed: approvals.filter((item) => item.status === `proposed`).length + broken, broken };
};

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
    const broken = computed<number>(() => owedOf(data.value).broken);
    const owed = computed<number>(() => owedOf(data.value).owed);

    return {
        approvals,
        invalid,
        owed,
        broken,
        error: computed(() => error.value?.message),
        isLoading,
        save,
        remove,
    };
}
