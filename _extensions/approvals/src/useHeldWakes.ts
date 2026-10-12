import { type AutomationApproval, awaitsOwner } from "@intentic/sandbox-contract";
import type { HostQuery } from "@intentic/extension-api";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

interface HeldWakes {
    readonly approvals: AutomationApproval[];
    // Files in the queue the sandbox could not read: held wakes that cannot run until they are fixed or removed.
    readonly unreadable?: string[];
}

// A held automation wake (requireApproval or holdForSeconds, parked on the sandbox's history volume, off the workspace),
// a separate store from agent approvals since it's daemon-minted and consumed on release. No `staleTime`: the daemon's
// `approvals` push reaches this read through the host's table of pushed reads the moment a wake is held, approved or
// rejected. The entry holds the procedure's whole answer; the view takes the list out in `select`.
export const heldWakesQuery = (): HostQuery<HeldWakes> => {
    const api = host();
    return {
        queryKey: api.sandbox.readKey(`automations.pendingList`),
        queryFn: (): Promise<HeldWakes> => api.sandbox.rpc.automations.pendingList(),
    };
};

// Only the holds that want a person (the contract's `awaitsOwner`, shared with the editor's inbox).
export const waitingOf = (held: readonly AutomationApproval[]): readonly AutomationApproval[] => held.filter(awaitsOwner);

export function useHeldWakes() {
    const api = host();
    const queryClient = useQueryClient();
    const spec = heldWakesQuery();
    const { query, error } = api.sandbox.query({
        ...spec,
        select: (list: HeldWakes): HeldWakes => list,
    });
    // Releasing a wake also shows up on the Automations page, so that read is invalidated by its procedure, not owned,
    // since this module only knows it went stale.
    const invalidate = (): Promise<void> => {
        void queryClient.invalidateQueries({ queryKey: api.sandbox.readKey(`automations.list`) });
        return queryClient.invalidateQueries({ queryKey: spec.queryKey });
    };

    const approve = useMutation({
        mutationFn: (id: string) => api.sandbox.rpc.automations.approve({ id }),
        onSuccess: invalidate,
    });
    const reject = useMutation({
        mutationFn: (id: string) => api.sandbox.rpc.automations.reject({ id }),
        onSuccess: invalidate,
    });

    return {
        held: computed<AutomationApproval[]>(() => query.data.value?.approvals ?? []),
        unreadable: computed<string[]>(() => query.data.value?.unreadable ?? []),
        error,
        isLoading: query.isLoading,
        approve,
        reject,
    };
}
