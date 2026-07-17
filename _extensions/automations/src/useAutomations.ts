import {
    type Automation,
    type AutomationApproval,
    AutomationApprovalsListSchema,
    type AutomationSummary,
    AutomationsListSchema,
} from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* The sandbox's automations manifest (.intentic/automations.json), read/written via the daemon's /automations
 * routes. `save` upserts by id (the enabled toggle re-posts the automation with the flag flipped); the daemon's
 * scheduler picks changes up on its next poll — nothing to provision, so no streamed apply. `pending` is the
 * owner's approval queue: a `requireApproval` automation holds each fire there instead of waking; `approve`
 * runs the held wake, `reject` drops it. All daemon access goes through the host api. */

// The event automation's webhook URL (with its daemon-minted token) for pasting into GitHub/Sentry/monitor
// settings — rendered by both the list rows and the create dialog's done screen.
export const webhookUrl = (automation: AutomationSummary): string | undefined => {
    const base = host().sandbox.origin();
    if (automation.trigger.kind !== `event` || base === undefined) {
        return undefined;
    }
    return `${base}/automations/${encodeURIComponent(automation.id)}/fire?token=${automation.trigger.token ?? ``}`;
};

export function useAutomations() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.key(`automations`);
    const pendingKey = api.sandbox.key(`automation-approvals`);
    const enabled = computed(() => api.sandbox.reachable());

    const query = useQuery({
        queryKey,
        queryFn: async (): Promise<AutomationSummary[]> => AutomationsListSchema.parse(await api.sandbox.json(`/automations`)).automations,
        enabled,
    });
    const pendingQuery = useQuery({
        queryKey: pendingKey,
        queryFn: async (): Promise<AutomationApproval[]> =>
            AutomationApprovalsListSchema.parse(await api.sandbox.json(`/automations/pending`)).approvals,
        enabled,
    });
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey });
    // Approving a held wake records a run, so refresh both the queue and the automation list.
    const invalidatePending = (): Promise<void> => {
        void queryClient.invalidateQueries({ queryKey });
        return queryClient.invalidateQueries({ queryKey: pendingKey });
    };

    const save = useMutation({
        mutationFn: (automation: Automation) =>
            api.sandbox.json(`/automations`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify(automation),
            }),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => api.sandbox.json(`/automations/${encodeURIComponent(id)}`, { method: `DELETE` }),
        onSuccess: invalidate,
    });
    const approve = useMutation({
        mutationFn: (id: string) => api.sandbox.json(`/automations/pending/${encodeURIComponent(id)}/approve`, { method: `POST` }),
        onSuccess: invalidatePending,
    });
    const reject = useMutation({
        mutationFn: (id: string) => api.sandbox.json(`/automations/pending/${encodeURIComponent(id)}/reject`, { method: `POST` }),
        onSuccess: invalidatePending,
    });

    return {
        automations: computed<AutomationSummary[]>(() => query.data.value ?? []),
        pending: computed<AutomationApproval[]>(() => pendingQuery.data.value ?? []),
        error: computed(() => (query.error.value ? query.error.value.message : null)),
        isLoading: query.isLoading,
        save,
        remove,
        approve,
        reject,
    };
}
