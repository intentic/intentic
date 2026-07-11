import { type SandboxSettings, SandboxSettingsSchema } from "@intentic-app/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../sandboxClient";
import { sandboxKey, useSandbox } from "../useSandbox";

/* The active sandbox's agent settings (.intentic/settings.json), read/written via the daemon's /settings routes.
 * Currently just `searchPastChats` — whether the agent may search this sandbox's earlier conversations. `save`
 * overwrites the whole object; the next turn's streamAgent reads it to gate the search_past_chats tool. */

const QUERY_KEY = sandboxKey(`settings`);

export function useSandboxSettings() {
    const { reachable } = useSandbox();
    const queryClient = useQueryClient();

    const query = useQuery({
        queryKey: QUERY_KEY,
        queryFn: async (): Promise<SandboxSettings> => SandboxSettingsSchema.parse(await sandboxJson(`/settings`)),
        enabled: reachable,
    });

    const save = useMutation({
        mutationFn: (settings: SandboxSettings) =>
            sandboxJson(`/settings`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify(settings),
            }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    });

    return {
        settings: computed<SandboxSettings | undefined>(() => query.data.value),
        isLoading: query.isLoading,
        save,
    };
}
