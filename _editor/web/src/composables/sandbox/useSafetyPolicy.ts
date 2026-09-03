import { type SafetyLogEntry, SafetyLogEntrySchema, type SafetyPolicy, SafetyPolicySchema } from "@intentic-app/api-contract";
import { useMutation } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "./sandboxClient";
import { jsonBody } from "./jsonBody";
import { queryClient } from "../queryPersistence";
import { SAFETY_LOG, SAFETY_POLICY } from "../queryKeys";
import { useSandboxQuery } from "./useSandboxQuery";
import { z } from "zod";

/* The safety policy (.intentic/config/safety.md) and the log of what it decided, read and written through the
 * daemon's /safety routes.
 *
 * NOT PART OF useSandboxSettings, and the separation is deliberate rather than incidental. That composable's
 * whole shape — patch one field, optimistically write the whole object, warn when the daemon drops a key — is
 * built for a bag of flags. This is one long piece of prose somebody types into an editor, so it wants the
 * opposite: no optimistic write per keystroke, an explicit save, and no field-level reconciliation, because
 * there are no fields.
 */

const POLICY_KEY = SAFETY_POLICY.of();
const LOG_KEY = SAFETY_LOG.of();

export function useSafetyPolicy() {
    const { query, error } = useSandboxQuery({
        queryKey: POLICY_KEY,
        queryFn: async (): Promise<SafetyPolicy> => SafetyPolicySchema.parse(await sandboxJson(`/safety/policy`)),
    });

    const save = useMutation(
        {
            mutationFn: (text: string) => sandboxJson(`/safety/policy`, jsonBody(`POST`, { text })),
            // Reconcile from the daemon rather than writing optimistically: a save here is an explicit act on a
            // document the user has been looking at, not a switch flip, so there is no stale-control problem to
            // solve and the honest thing is to show what was actually stored.
            onSettled: async () => {
                await queryClient.invalidateQueries({ queryKey: POLICY_KEY });
            },
        },
        queryClient,
    );

    const policy = computed<SafetyPolicy | undefined>(() => query.data.value);
    return {
        policy,
        // The text as stored, or undefined until it loads. `custom` is false when this is the shipped default,
        // which is what lets the page offer "reset" honestly and say that an unconfigured sandbox is still
        // governed by something.
        text: computed<string>(() => policy.value?.text ?? ``),
        custom: computed<boolean>(() => policy.value?.custom ?? false),
        save: (text: string) => {
            save.mutate(text);
        },
        isSaving: computed<boolean>(() => save.isPending.value),
        isLoading: query.isLoading,
        error,
    };
}

export function useSafetyLog() {
    const { query, error } = useSandboxQuery({
        queryKey: LOG_KEY,
        queryFn: async (): Promise<SafetyLogEntry[]> => z.array(SafetyLogEntrySchema).parse(await sandboxJson(`/safety/log`)),
    });
    return { entries: computed<SafetyLogEntry[]>(() => query.data.value ?? []), isLoading: query.isLoading, error };
}
