import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { z } from "zod";
import { host } from "./host";

// What the install panel reads: the chat's automation as the sandbox lists it, and which sites have loaded its widget
// (this extension's backend, `installs/<id>`), polled while the panel is open, since a working widget nobody has used
// and one never pasted both show nothing yet.

const INSTALL_POLL_MS = 4_000;

const InstallsSchema = z.object({
    origins: z.array(z.object({ origin: z.string(), allowed: z.boolean(), lastSeenAt: z.number(), loads: z.number() })),
});
export type VisitorChatInstall = z.infer<typeof InstallsSchema>[`origins`][number];

export function useChat(automationId: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.readKey(`automations.list`);
    const { query } = api.sandbox.query({
        queryKey,
        queryFn: () => api.sandbox.rpc.automations.list(),
        select: (answer): AutomationSummary[] => answer.automations,
    });
    // Saved through the sandbox's own route, which validates it as the Automations view's save does.
    const save = useMutation({
        mutationFn: (automation: Parameters<typeof api.sandbox.rpc.automations.upsert>[0]) => api.sandbox.rpc.automations.upsert(automation),
        onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    });
    return {
        chat: computed(() => query.data.value?.find((automation) => automation.id === automationId.value)),
        save,
    };
}

export function useInstalls(automationId: Ref<string>) {
    const api = host();
    const { query, error } = api.sandbox.query({
        queryKey: computed(() => api.sandbox.key(`visitor-chat-installs`, automationId.value)),
        queryFn: async (): Promise<VisitorChatInstall[]> =>
            InstallsSchema.parse(await api.backend.json(`installs/${encodeURIComponent(automationId.value)}`)).origins,
        enabled: computed(() => automationId.value !== ``),
        refetchInterval: INSTALL_POLL_MS,
    });
    return {
        installs: computed<VisitorChatInstall[]>(() => query.data.value ?? []),
        isLoading: query.isLoading,
        error,
    };
}
