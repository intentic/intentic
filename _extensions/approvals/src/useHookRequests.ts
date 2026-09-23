import { type HookRequest, type HookRequests, roleAtLeast } from "@intentic/sandbox-contract";
import type { HostQuery } from "@intentic/extension-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

// Hook sets a turn found in Claude Code's settings files that nobody approved. The daemon keeps them outside the
// workspace, so no file write announces one: filed under `approvals` so the daemon's own push for that key refreshes it.
export const hookRequestsQuery = (): HostQuery<HookRequests> => {
    const api = host();
    return {
        queryKey: api.sandbox.key(`approvals`, `hooks`),
        queryFn: (): Promise<HookRequests> => api.sandbox.rpc.approvals.hookRequests(),
    };
};

// A dismissed set is kept off on purpose and owes nobody anything, so it neither badges nor counts as waiting.
export const waitingHooksOf = (list: HookRequests | undefined): readonly HookRequest[] => (list?.requests ?? []).filter((request) => request.dismissed !== true);

export function useHookRequests() {
    const api = host();
    const queryClient = useQueryClient();
    const spec = hookRequestsQuery();
    const { data, error } = useQuery({
        ...spec,
        // Floored at maintainer daemon-side: below it the read is refused, so it isn't asked.
        enabled: computed(() => api.sandbox.reachable() && roleAtLeast(api.sandbox.role(), `maintainer`)),
    });
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: spec.queryKey });

    const approve = useMutation({
        mutationFn: (digest: string) => api.sandbox.rpc.approvals.approveHooks({ digest }),
        onSuccess: invalidate,
    });
    const dismiss = useMutation({
        mutationFn: (digest: string) => api.sandbox.rpc.approvals.dismissHooks({ digest }),
        onSuccess: invalidate,
    });

    return {
        hookSets: computed<HookRequest[]>(() => data.value?.requests ?? []),
        ledgerUnreadable: computed(() => data.value?.ledgerUnreadable === true),
        error: computed(() => error.value?.message),
        approve,
        dismiss,
    };
}
