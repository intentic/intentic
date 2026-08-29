import { type Automation, type AutomationApproval, type AutomationSummary, AutomationsListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { approvalsQuery } from "./approvalsQuery";
import { host } from "./host";

/* The sandbox's automations manifest (.intentic/config/automations.json), read/written via the daemon's /automations
 * routes. `save` upserts by id; `setEnabled` has its own narrow route so switching a row cannot discard fields;
 * the daemon's
 * scheduler picks changes up on its next poll, nothing to provision, so no streamed apply. `pending` is the
 * owner's approval queue: a `requireApproval` automation holds each fire there instead of waking; `approve`
 * runs the held wake, `reject` drops it. All daemon access goes through the host api. */

// How long after a by-hand fire to re-read the list for its outcome. A guard-skip and a short wake both land
// well inside this; a long turn's outcome arrives with the next ordinary refetch.
const RUN_SETTLE_POLL_MS = 5_000;

// The event automation's webhook URL (with its daemon-minted token) for pasting into GitHub/Sentry/monitor
// settings, rendered by both the list rows and the create dialog's done screen.
export const webhookUrl = (automation: AutomationSummary): string | undefined => {
    const base = host().sandbox.origin();
    if (automation.trigger.kind !== `event` || base === undefined) {
        return undefined;
    }
    return `${base}/automations/${encodeURIComponent(automation.id)}/fire?token=${automation.trigger.token ?? ``}`;
};

/* The one line a customer pastes into their site to put a Front Desk on it. The daemon's own origin serves both
 * the bundle and the routes it talks to, so the snippet needs no second address and no key, the automation id
 * is the whole address, and the origin allowlist below it is what decides who may use it. */
export const embedSnippet = (automation: AutomationSummary): string | undefined => {
    const base = host().sandbox.origin();
    if (automation.trigger.kind !== `listener` || automation.trigger.provider !== `webchat` || base === undefined) {
        return undefined;
    }
    return `<script src="${base}/webchat/widget.js" data-automation="${automation.id}" defer></script>`;
};

/* Which sites have actually loaded a Front Desk's widget, the answer to "did the snippet land?", which nothing
 * else in the app can give: a working Front Desk nobody has written to and one that was never pasted both show an
 * empty run history. Polled rather than pushed, and only while the install panel is open (`enabled`), because
 * the one minute after pasting a snippet is the entire window in which this changes for anyone. */
export interface FrontDeskInstall {
    readonly origin: string;
    readonly allowed: boolean;
    readonly lastSeenAt: number;
    readonly loads: number;
}

const INSTALL_POLL_MS = 4_000;

export function useFrontDeskInstalls(automationId: Ref<string | undefined>, enabled: Ref<boolean>) {
    const api = host();
    const query = useQuery({
        queryKey: computed(() => api.sandbox.key(`webchat-installs`, automationId.value ?? ``)),
        queryFn: async (): Promise<FrontDeskInstall[]> => {
            const id = automationId.value;
            if (id === undefined) {
                return [];
            }
            const body = (await api.sandbox.json(`/webchat/${encodeURIComponent(id)}/installs`)) as { origins?: FrontDeskInstall[] };
            return body.origins ?? [];
        },
        enabled: computed(() => enabled.value && automationId.value !== undefined && api.sandbox.reachable()),
        refetchInterval: INSTALL_POLL_MS,
    });
    return {
        installs: computed<FrontDeskInstall[]>(() => query.data.value ?? []),
        isLoading: query.isLoading,
        error: computed(() => query.error.value?.message),
    };
}

export function useAutomations() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.key(`automations`);
    // The queue's read model, shared with the rail badge's background poll rather than written out again here:
    // whichever of the two asks first fills the entry the other paints from (approvalsQuery.ts).
    const pending = approvalsQuery();
    const pendingKey = pending.queryKey;
    const enabled = computed(() => api.sandbox.reachable());

    const query = useQuery({
        queryKey,
        queryFn: async (): Promise<AutomationSummary[]> => AutomationsListSchema.parse(await api.sandbox.json(`/automations`)).automations,
        enabled,
    });
    const pendingQuery = useQuery({ ...pending, enabled });
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
    const setEnabled = useMutation({
        mutationFn: ({ id, enabled: next }: { id: string; enabled: boolean }) =>
            api.sandbox.json(`/automations/${encodeURIComponent(id)}/enabled`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ enabled: next }),
            }),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => api.sandbox.json(`/automations/${encodeURIComponent(id)}`, { method: `DELETE` }),
        onSuccess: invalidate,
    });
    /* Fire one now, without waiting for its cron / forging its webhook / provoking a Discord mention. The daemon
     * acks immediately and runs the turn detached, so success here means "it started", not "it finished", the run
     * row is where the outcome lands. Hence the two invalidations: one now for the fire, one a few seconds later
     * for the outcome, since a wake that takes minutes has no push to announce it into this page. */
    const run = useMutation({
        mutationFn: (id: string) => api.sandbox.json(`/automations/${encodeURIComponent(id)}/run`, { method: `POST` }),
        onSuccess: async () => {
            await invalidate();
            setTimeout(() => void invalidate(), RUN_SETTLE_POLL_MS);
        },
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
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
        save,
        setEnabled,
        remove,
        run,
        approve,
        reject,
    };
}
