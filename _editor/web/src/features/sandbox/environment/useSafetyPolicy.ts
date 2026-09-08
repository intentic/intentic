import { type SafetyLogEntry, SafetyLogEntrySchema, type SafetyPolicy, SafetyPolicySchema } from "@intentic/api-contract";
import { useMutation } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../client/sandboxClient";
import { jsonBody } from "../client/jsonBody";
import { queryClient } from "../../../lib/queryPersistence";
import { SAFETY_LOG, SAFETY_POLICY } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";
import { z } from "zod";

// The safety policy (.intentic/config/safety.md) and its decision log, read and written via the daemon's /safety
// routes. Kept out of useSandboxSettings on purpose: that composable optimistically patches a bag of flags, while this
// is one prose document that wants an explicit save, not a write per keystroke.

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
            // Reconciles from the daemon rather than writing optimistically: a save is an explicit act, not a toggle,
            // so there's no stale control to protect against.
            onSettled: async () => {
                await queryClient.invalidateQueries({ queryKey: POLICY_KEY });
            },
        },
        queryClient,
    );

    const policy = computed<SafetyPolicy | undefined>(() => query.data.value);
    return {
        policy,
        // `custom` is false for the shipped default, so 'reset' can be offered honestly and an unconfigured sandbox
        // still reads as governed.
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
