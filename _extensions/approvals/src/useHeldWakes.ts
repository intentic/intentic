import { type AutomationApproval, AutomationApprovalsListSchema } from "@intentic/sandbox-contract";
import type { HostQuery } from "@intentic/extension-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

// A held automation wake (requireApproval or holdForSeconds, parked in .intentic/records/approvals/), a separate store
// from agent approvals since it's daemon-minted and consumed on release. No `staleTime`: the manifest invalidates this
// key the moment a wake is held, approved or rejected.
export const heldWakesQuery = (): HostQuery<AutomationApproval[]> => {
    const api = host();
    return {
        queryKey: api.sandbox.key(`automation-approvals`),
        queryFn: async (): Promise<AutomationApproval[]> =>
            AutomationApprovalsListSchema.parse(await api.sandbox.json(`/automations/pending`)).approvals,
    };
};

// Only holds with no `autoRunAt` want a person; a countdown hold releases itself, so counting it would badge something
// already about to happen on its own.
export const waitingOf = (held: readonly AutomationApproval[]): readonly AutomationApproval[] => held.filter((wake) => wake.autoRunAt === undefined);

export function useHeldWakes() {
    const api = host();
    const queryClient = useQueryClient();
    const spec = heldWakesQuery();
    const { data, error, isLoading } = useQuery({
        ...spec,
        enabled: computed(() => api.sandbox.reachable()),
    });
    // Releasing a wake also shows up on the Automations page, so that key is invalidated by name, not owned, since this
    // module only knows it went stale.
    const invalidate = (): Promise<void> => {
        void queryClient.invalidateQueries({ queryKey: api.sandbox.key(`automations`) });
        return queryClient.invalidateQueries({ queryKey: spec.queryKey });
    };

    const approve = useMutation({
        mutationFn: (id: string) => api.sandbox.json(`/automations/pending/${encodeURIComponent(id)}/approve`, { method: `POST` }),
        onSuccess: invalidate,
    });
    const reject = useMutation({
        mutationFn: (id: string) => api.sandbox.json(`/automations/pending/${encodeURIComponent(id)}/reject`, { method: `POST` }),
        onSuccess: invalidate,
    });

    return {
        held: computed<AutomationApproval[]>(() => data.value ?? []),
        error: computed(() => error.value?.message),
        isLoading,
        approve,
        reject,
    };
}
