import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/api-contract";
import { useMutation } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { sandboxJson } from "../client/sandboxClient";
import { jsonBody } from "../client/jsonBody";
import { queryClient } from "../../../lib/queryPersistence";
import { SANDBOX_SETTINGS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// Active sandbox's agent settings (.intentic/config/settings.json), read/written via the daemon's /settings routes. All
// per-sandbox agent toggles; `save` overwrites the whole object, and the next turn's streamAgent reads it to gate
// behavior.

const QUERY_KEY = SANDBOX_SETTINGS.of();

// Module-level, not per-caller: the Agent tab is several separately-mounted groups over one settings object, and any of
// them can trigger this.
const dropped = ref<string | undefined>(undefined);

// Names a field the daemon's POST accepted but didn't keep (an older schema predates it): compares what was sent
// against what a successful write actually stored.
const droppedFieldsReason = (sent: SandboxSettings, stored: SandboxSettings): string | undefined => {
    const droppedKeys = Object.keys(sent).filter((key) => {
        const field = key as keyof SandboxSettings;
        return JSON.stringify(stored[field]) !== JSON.stringify(sent[field]);
    });
    if (droppedKeys.length === 0) {
        return undefined;
    }
    // Same dev-vs-production split as staleDaemonReason.
    const remedy = import.meta.env.DEV
        ? `Your dev image predates it: run 'sh _sandbox/sandbox/scripts/dev-reload.sh'.`
        : `Update the sandbox to a newer image to use it.`;
    return `This sandbox's daemon didn't keep ${droppedKeys.join(`, `)}. ${remedy}`;
};

export function useSandboxSettings() {
    const { query, error } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async (): Promise<SandboxSettings> => SandboxSettingsSchema.parse(await sandboxJson(`/settings`)),
    });

    const save = useMutation(
        {
            mutationFn: (settings: SandboxSettings) => sandboxJson(`/settings`, jsonBody(`POST`, settings)),
            // Writes into the cache before the request lands, since every control on the page reads its value and
            // disabled state from this object; otherwise a click shows the old value until the round-trip completes.
            onMutate: async (settings) => {
                dropped.value = undefined;
                // A refetch in flight could otherwise land after this write and overwrite it with pre-click state.
                await queryClient.cancelQueries({ queryKey: QUERY_KEY });
                const previous = queryClient.getQueryData<SandboxSettings>(QUERY_KEY);
                queryClient.setQueryData<SandboxSettings>(QUERY_KEY, settings);
                return { previous };
            },
            // Puts back exactly what was on screen before the click, so a switch never claims a setting the sandbox
            // refused.
            onError: (_error, _settings, context) => {
                if (context?.previous !== undefined) {
                    queryClient.setQueryData<SandboxSettings>(QUERY_KEY, context.previous);
                }
            },
            // Reconciles with what the daemon actually stored either way; a dropped field snaps back silently, so name
            // it once the reconciling read lands (droppedFieldsReason).
            onSettled: async (_data, saveError, settings) => {
                await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
                const stored = queryClient.getQueryData<SandboxSettings>(QUERY_KEY);
                if (saveError !== null || stored === undefined) {
                    return;
                }
                dropped.value = droppedFieldsReason(settings, stored);
            },
        },
        // Same client the reads above use, named rather than injected (see useSandboxQuery).
        queryClient,
    );

    const settings = computed<SandboxSettings | undefined>(() => query.data.value);

    // The whole object, with just these fields changed, since the route replaces it entirely; settings not yet loaded
    // means nothing to spread, so the write is dropped instead of inventing a base.
    const patch = (fields: Partial<SandboxSettings>): void => {
        if (settings.value !== undefined) {
            save.mutate({ ...settings.value, ...fields });
        }
    };

    return {
        settings,
        patch,
        isLoading: query.isLoading,
        // Every control is disabled until `settings` arrives; render this so a failed read isn't left unexplained.
        error,
        // Set when the last successful save came back missing a field: the daemon is older than this app.
        dropped,
        save,
    };
}
