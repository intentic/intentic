import { type SandboxSettings, SandboxSettingsSchema } from "@intentic-app/api-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "./sandboxClient";
import { sandboxKey } from "./useSandbox";
import { useSandboxQuery } from "./useSandboxQuery";

/* The active sandbox's agent settings (.intentic/settings.json), read/written via the daemon's /settings routes.
 * All per-sandbox agent toggles (iq search, hashline edits, output cleaning, prompt stability, …). `save`
 * overwrites the whole object; the next turn's streamAgent reads it to gate each behavior. */

const QUERY_KEY = sandboxKey(`settings`);

export function useSandboxSettings() {
    const queryClient = useQueryClient();

    const { query } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async (): Promise<SandboxSettings> => SandboxSettingsSchema.parse(await sandboxJson(`/settings`)),
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
