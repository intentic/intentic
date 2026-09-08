import type { IssuesList, IssueStatus, IssueSummary } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

// Bug inbox (.intentic/records/issues/, one file per fingerprint) read through the daemon's /issues routes. The daemon
// writes issues as reports arrive; this side only triages (setStatus/investigate/remove, no create). The manifest binds
// that directory to this query key, so a new report updates the count without a poll.

export const issuesQuery = () => ({
    queryKey: host().sandbox.key(`issues`),
    queryFn: (): Promise<IssuesList> => host().sandbox.rpc.issues.list(),
});

// Owed counts only `open` rows (others are already handled or decided, so the badge could never return to zero). Broken
// is the louder subset: an unreadable file, or a resolved issue that came back.
export const owedOf = (list: IssuesList | undefined): { owed: number; broken: number } => {
    const issues = list?.issues ?? [];
    const open = issues.filter((issue) => issue.status === `open`);
    // An open row with a run was closed and reopened by a recurrence.
    const returned = open.filter((issue) => (issue.runs?.length ?? 0) > 0).length;
    return { owed: open.length, broken: returned + (list?.invalid.length ?? 0) };
};

// Order within the store; `open` ranks first since it's the only status asking for anything.
const RANK: Record<IssueStatus, number> = { open: 0, investigating: 1, resolved: 2, ignored: 3 };

export function useIssues() {
    const api = host();
    const queryClient = useQueryClient();
    const spec = issuesQuery();
    const { data, error, isLoading } = useQuery({
        ...spec,
        enabled: computed(() => api.sandbox.reachable()),
    });
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: spec.queryKey });

    const setStatus = useMutation({
        mutationFn: ({ id, status }: { id: string; status: `open` | `resolved` | `ignored` }) => api.sandbox.rpc.issues.status({ id, status }),
        onSuccess: invalidate,
    });
    const investigate = useMutation({
        mutationFn: (id: string) => api.sandbox.rpc.issues.investigate({ id }),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => api.sandbox.rpc.issues.remove({ id }),
        onSuccess: invalidate,
    });

    const issues = computed<IssueSummary[]>(() =>
        (data.value?.issues ?? []).toSorted((a, b) => RANK[a.status] - RANK[b.status] || b.lastSeen - a.lastSeen),
    );

    return {
        issues,
        invalid: computed<string[]>(() => data.value?.invalid ?? []),
        owed: computed<number>(() => owedOf(data.value).owed),
        broken: computed<number>(() => owedOf(data.value).broken),
        error: computed(() => error.value?.message),
        isLoading,
        setStatus,
        investigate,
        remove,
    };
}
