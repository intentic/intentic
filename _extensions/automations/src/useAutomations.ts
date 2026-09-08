import { type Automation, type AutomationSummary, AutomationsListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

// The sandbox's automations manifest (.intentic/config/automations.json) via the daemon's /automations routes. `save`
// upserts by id; `setEnabled` uses its own route so toggling a row can't discard fields. requireApproval wakes belong
// to the Approvals page, not here.

// How long after a manual fire to re-read for its outcome; a guard-skip or short wake lands well inside this.
const RUN_SETTLE_POLL_MS = 5_000;

// Event automation's webhook URL, including its daemon-minted token, for pasting into GitHub/Sentry etc. The token
// isn't on the record; the daemon attaches it only for a maintainer or owner, so a viewer's list renders none.
export const webhookUrl = (automation: AutomationSummary): string | undefined => {
    const base = host().sandbox.origin();
    if (automation.trigger.kind !== `event` || base === undefined || automation.webhookToken === undefined) {
        return undefined;
    }
    return `${base}/automations/${encodeURIComponent(automation.id)}/fire?token=${encodeURIComponent(automation.webhookToken)}`;
};

// Snippet a customer pastes to put a Front Desk on their site. The daemon's own origin serves both the bundle and its
// routes, so only the automation id is needed; the origin allowlist decides who may use it.
export const embedSnippet = (automation: AutomationSummary): string | undefined => {
    const base = host().sandbox.origin();
    if (automation.trigger.kind !== `listener` || automation.trigger.provider !== `webchat` || base === undefined) {
        return undefined;
    }
    return `<script src="${base}/webchat/widget.js" data-automation="${automation.id}" defer></script>`;
};

// Which sites have actually loaded a Front Desk's widget; a working widget nobody has used and one never pasted both
// show empty history. Polled only while the install panel is open.
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
    const enabled = computed(() => api.sandbox.reachable());

    const query = useQuery({
        queryKey,
        queryFn: async (): Promise<AutomationSummary[]> => AutomationsListSchema.parse(await api.sandbox.json(`/automations`)).automations,
        enabled,
    });
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey });

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
    // A fresh webhook token (or intake key), the old one retired at once; the list re-reads to show the new URL.
    const rotateToken = useMutation({
        mutationFn: (id: string) => api.sandbox.json(`/automations/${encodeURIComponent(id)}/rotate-token`, { method: `POST` }),
        onSuccess: invalidate,
    });
    // Fires now without waiting for cron, webhook, or a Discord mention. The daemon acks immediately and runs detached,
    // so success means "started", not "finished"; a second invalidation lands a few seconds later for the outcome.
    const run = useMutation({
        mutationFn: (id: string) => api.sandbox.json(`/automations/${encodeURIComponent(id)}/run`, { method: `POST` }),
        onSuccess: async () => {
            await invalidate();
            setTimeout(() => void invalidate(), RUN_SETTLE_POLL_MS);
        },
    });
    return {
        automations: computed<AutomationSummary[]>(() => query.data.value ?? []),
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
        save,
        setEnabled,
        remove,
        rotateToken,
        run,
    };
}
