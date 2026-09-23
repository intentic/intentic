import type { Automation, AutomationSummary, SenderSeen } from "@intentic/sandbox-contract";
import { asZone, UTC, type Zone } from "@intentic/sandbox-contract/time";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type ComputedRef, type Ref } from "vue";
import { host } from "./host";

// Who has written to a listener source, admitted or not, for the sender rules picker: offered by name, stored by id.
// Fetched only while a form on that source is open, and re-read on open rather than pushed: the daemon writes this on
// every inbound message, and a live key would refetch every browser per Discord message for a list nobody has up.
const NO_SENDERS: readonly SenderSeen[] = [];

export function useSenders(provider: Ref<string>, enabled: Ref<boolean>) {
    const api = host();
    const query = useQuery({
        queryKey: computed(() => api.sandbox.key(`automation-senders`, provider.value)),
        queryFn: () => api.sandbox.rpc.automations.senders({ provider: provider.value }),
        enabled: computed(() => enabled.value && provider.value !== `` && api.sandbox.reachable()),
    });
    return { senders: computed<readonly SenderSeen[]>(() => query.data.value?.senders ?? NO_SENDERS) };
}

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

// Snippet a customer pastes to put a Visitor chat on their site. The daemon's own origin serves both the bundle and its
// routes, so only the automation id is needed; the origin allowlist decides who may use it.
export const embedSnippet = (automation: AutomationSummary): string | undefined => {
    const base = host().sandbox.origin();
    if (automation.trigger.kind !== `listener` || automation.trigger.provider !== `webchat` || base === undefined) {
        return undefined;
    }
    return `<script src="${base}/webchat/widget.js" data-automation="${automation.id}" defer></script>`;
};

// Which sites have actually loaded a Visitor chat's widget; a working widget nobody has used and one never pasted both
// show empty history. Polled only while the install panel is open.
export interface VisitorChatInstall {
    readonly origin: string;
    readonly allowed: boolean;
    readonly lastSeenAt: number;
    readonly loads: number;
}

const INSTALL_POLL_MS = 4_000;

export function useVisitorChatInstalls(automationId: Ref<string | undefined>, enabled: Ref<boolean>) {
    const api = host();
    const query = useQuery({
        queryKey: computed(() => api.sandbox.key(`webchat-installs`, automationId.value ?? ``)),
        queryFn: async (): Promise<VisitorChatInstall[]> => {
            const id = automationId.value;
            if (id === undefined) {
                return [];
            }
            const body = (await api.sandbox.json(`/webchat/${encodeURIComponent(id)}/installs`)) as { origins?: VisitorChatInstall[] };
            return body.origins ?? [];
        },
        enabled: computed(() => enabled.value && automationId.value !== undefined && api.sandbox.reachable()),
        refetchInterval: INSTALL_POLL_MS,
    });
    return {
        installs: computed<VisitorChatInstall[]>(() => query.data.value ?? []),
        isLoading: query.isLoading,
        error: computed(() => query.error.value?.message),
    };
}

/**
 * The clock this sandbox's schedules are set by, for every surface here that shows or edits one. Read from the daemon
 * rather than from `Intl.DateTimeFormat()`, which answers the READER's zone: the two agree for the owner sitting at
 * their own machine and diverge for everyone else — a colleague opening the workspace from another country, a phone in
 * an airport — and it is the daemon's answer that decides when anything actually fires.
 * UTC while the settings read is in flight, which is also the daemon's own fallback, so the screen never briefly shows
 * a zone nothing would fire in.
 */
export function useSandboxZone(): ComputedRef<Zone> {
    const api = host();
    const query = useQuery({
        queryKey: api.sandbox.key(`sandbox-timezone`),
        queryFn: async (): Promise<string> => (await api.sandbox.rpc.settings.get()).timezone ?? ``,
        enabled: computed(() => api.sandbox.reachable()),
    });
    return computed<Zone>(() => asZone(query.data.value) ?? UTC);
}

export function useAutomations() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.key(`automations`);
    const enabled = computed(() => api.sandbox.reachable());

    const query = useQuery({
        queryKey,
        queryFn: async (): Promise<AutomationSummary[]> => (await api.sandbox.rpc.automations.list()).automations,
        enabled,
    });
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey });

    const save = useMutation({
        mutationFn: (automation: Automation) => api.sandbox.rpc.automations.upsert(automation),
        onSuccess: invalidate,
    });
    const setEnabled = useMutation({
        mutationFn: (input: { id: string; enabled: boolean }) => api.sandbox.rpc.automations.setEnabled(input),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => api.sandbox.rpc.automations.remove({ id }),
        onSuccess: invalidate,
    });
    // A fresh webhook token (or intake key), the old one retired at once; the list re-reads to show the new URL.
    const rotateToken = useMutation({
        mutationFn: (id: string) => api.sandbox.rpc.automations.rotateToken({ id }),
        onSuccess: invalidate,
    });
    // Fires now without waiting for cron, webhook, or a Discord mention. The daemon acks immediately and runs detached,
    // so success means "started", not "finished"; a second invalidation lands a few seconds later for the outcome.
    const run = useMutation({
        mutationFn: (id: string) => api.sandbox.rpc.automations.run({ id }),
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
