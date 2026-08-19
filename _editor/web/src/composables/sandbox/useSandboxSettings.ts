import { type SandboxSettings, SandboxSettingsSchema } from "@intentic-app/api-contract";
import { useMutation } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { sandboxJson } from "./sandboxClient";
import { jsonBody } from "./jsonBody";
import { queryClient } from "../queryPersistence";
import { SANDBOX_SETTINGS } from "../queryKeys";
import { useSandboxQuery } from "./useSandboxQuery";

/* The active sandbox's agent settings (.intentic/config/settings.json), read/written via the daemon's /settings routes.
 * All per-sandbox agent toggles (iq search, hashline edits, output cleaning, prompt stability, …). `save`
 * overwrites the whole object; the next turn's streamAgent reads it to gate each behavior. */

const QUERY_KEY = SANDBOX_SETTINGS.of();

/* MODULE-LEVEL, not per-caller: this describes the DAEMON — that it is older than this app and silently drops a
 * field it doesn't know — so every settings surface is entitled to say so no matter which one wrote. The Agent
 * tab is a page of separately-mounted groups over one settings object, and a per-instance ref would have shown
 * the warning only inside whichever group happened to own the control that snapped back. */
const dropped = ref<string | undefined>(undefined);

/* A setting the daemon DIDN'T KEEP, named. The daemon parses our POST against its OWN copy of
 * SandboxSettingsSchema, and the browser is routinely newer than the sandbox image answering it (useDaemonRoutes
 * says why that is supported, not an error) — so a field added after that image was built is stripped in
 * silence: the write succeeds, the reconciling read comes back without it, and the control springs back to its
 * old value. That reaches the user as an input that "won't take a number", the field-level twin of the 404
 * staleDaemonReason already names. Compare what came back with what was sent and say which key was dropped.
 *
 * The daemon stores the object verbatim, so any per-key difference after a successful write means exactly this. */
const droppedFieldsReason = (sent: SandboxSettings, stored: SandboxSettings): string | undefined => {
    const droppedKeys = Object.keys(sent).filter((key) => {
        const field = key as keyof SandboxSettings;
        return JSON.stringify(stored[field]) !== JSON.stringify(sent[field]);
    });
    if (droppedKeys.length === 0) {
        return undefined;
    }
    // The two audiences differ only in what they can do about it — same split staleDaemonReason draws.
    const remedy = import.meta.env.DEV
        ? `Your dev image predates it — run 'sh _sandbox/sandbox/scripts/dev-reload.sh'.`
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
            // Write the new settings into the cache the controls render from, BEFORE the request. Every control on
            // the page reads its value — and its disabled state — from this one object, so without this a click
            // leaves the switch showing the OLD value for a daemon round-trip and then jumping; a control mid-flight
            // is the stalest thing on screen precisely while the user is looking at it.
            onMutate: async (settings) => {
                dropped.value = undefined;
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
            // daemon dropping a newly-added toggle) then visibly snaps back instead of lying. Snapping back is
            // honest but mute, so name the dropped field once the reconciling read has landed (droppedFieldsReason).
            onSettled: async (_data, saveError, settings) => {
                await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
                const stored = queryClient.getQueryData<SandboxSettings>(QUERY_KEY);
                if (saveError !== null || stored === undefined) {
                    return;
                }
                dropped.value = droppedFieldsReason(settings, stored);
            },
        },
        // Same client the reads above use, named rather than injected — see useSandboxQuery for why.
        queryClient,
    );

    const settings = computed<SandboxSettings | undefined>(() => query.data.value);

    /* THE WRITE EVERY CONTROL ACTUALLY WANTS. The route takes the whole object, so a single toggle has to be
     * sent as "everything currently saved, with this one field changed" — and doing that at each call site is
     * how a settings page ends up with two dozen identical read-guard-spread functions, any one of which can
     * quietly send a stale copy. Settings not yet loaded ⇒ nothing to spread, and every control is disabled in
     * that state anyway, so the write is dropped rather than inventing a base object to write over. */
    const patch = (fields: Partial<SandboxSettings>): void => {
        if (settings.value !== undefined) {
            save.mutate({ ...settings.value, ...fields });
        }
    };

    return {
        settings,
        patch,
        isLoading: query.isLoading,
        // Every control on the settings page is disabled until `settings` arrives, so a read that fails leaves a
        // page of switches that look live and do nothing. Callers render this instead of leaving it unexplained.
        error,
        // Set when the last successful save came back missing a field — the daemon is older than this app.
        dropped,
        save,
    };
}
