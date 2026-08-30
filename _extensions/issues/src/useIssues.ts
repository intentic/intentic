import type { IssuesList, IssueStatus, IssueSummary } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* The bug inbox (.intentic/records/issues/, one file per fingerprint), read through the daemon's /issues routes.
 *
 * NOTHING HERE CREATES ONE, which is the difference from the drafts queue this is otherwise shaped like: a
 * draft is written by the agent and this side approves it, while an issue is written by the DAEMON as reports
 * arrive at the public intake, and this side triages. So there is no upsert, only `setStatus`, `investigate`
 * and `remove`.
 *
 * The manifest's `contributes.files` entry points `.intentic/records/issues/` at this query key, so a crash
 * landing while the owner is looking at the page moves the count on screen without a poll. */

export const issuesQuery = () => ({
    queryKey: host().sandbox.key(`issues`),
    queryFn: (): Promise<IssuesList> => host().sandbox.rpc.issues.list(),
});

/* What the inbox OWES its owner, for the badge and the mobile chip, without mounting the view.
 *
 * `open` is the whole of it and the omissions are the point: `investigating` is already being dealt with,
 * `resolved` and `ignored` are decisions the owner has made, and counting any of them gives a badge that never
 * returns to zero, which is how a badge stops being read. `broken` is the subset that is louder than merely
 * new: an unreadable file (nothing but the daemon writes these, so one that will not parse is a real fault) and
 * anything that has come back after being resolved, which is a fix that did not hold. */
export const owedOf = (list: IssuesList | undefined): { owed: number; broken: number } => {
    const issues = list?.issues ?? [];
    const open = issues.filter((issue) => issue.status === `open`);
    // Reopened by a recurrence: the daemon clears `firedAt` when a resolved group comes back, so an open row
    // that has already had a run is one that was closed and did not stay closed.
    const returned = open.filter((issue) => (issue.runs?.length ?? 0) > 0).length;
    return { owed: open.length, broken: returned + (list?.invalid.length ?? 0) };
};

// Newest first within a bucket is the store's own order; the buckets are what the page reads down. `open` above
// everything because it is the only one asking for anything.
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

    const issues = computed<IssueSummary[]>(() => (data.value?.issues ?? []).toSorted((a, b) => RANK[a.status] - RANK[b.status] || b.lastSeen - a.lastSeen));

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
