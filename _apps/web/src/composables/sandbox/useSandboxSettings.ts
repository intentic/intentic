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

    const { query, error } = useSandboxQuery({
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
        // Write the new settings into the cache the controls render from, BEFORE the request. Every control on
        // the page reads its value — and its disabled state — from this one object, so without this a click
        // leaves the switch showing the OLD value for a daemon round-trip and then jumping; a control mid-flight
        // is the stalest thing on screen precisely while the user is looking at it.
        onMutate: async (settings) => {
            // A refetch in flight would otherwise land after this write and overwrite it with pre-click state.
            await queryClient.cancelQueries({ queryKey: QUERY_KEY });
            const previous = queryClient.getQueryData<SandboxSettings>(QUERY_KEY);
            queryClient.setQueryData<SandboxSettings>(QUERY_KEY, settings);
            return { previous };
        },
        // The daemon refused it or was unreachable: put back exactly what was on screen before the click, so the
        // switch never claims a setting the sandbox doesn't have.
        onError: (_error, _settings, context) => {
            if (context?.previous !== undefined) {
                queryClient.setQueryData<SandboxSettings>(QUERY_KEY, context.previous);
            }
        },
        // Either way, reconcile with what the daemon actually stored — a field it doesn't understand (an older
        // daemon dropping a newly-added toggle) then visibly snaps back instead of lying.
        onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    });

    return {
        settings: computed<SandboxSettings | undefined>(() => query.data.value),
        isLoading: query.isLoading,
        // Every control on the settings page is disabled until `settings` arrives, so a read that fails leaves a
        // page of switches that look live and do nothing. Callers render this instead of leaving it unexplained.
        error,
        save,
    };
}
