import type { PrivacyKnownSource, PrivacyLedgerEntry, PrivacyShieldPolicy, PrivacyShieldStatus } from "@intentic/sandbox-contract";
import { useMutation } from "@tanstack/vue-query";
import { computed } from "vue";
import { rpcQuery } from "../../client/rpcQuery";
import { sandboxRpc } from "../../client/sandboxRpc";
import { useSandboxQuery } from "../../client/useSandboxQuery";
import { rpcKey } from "../../../../lib/queryKeys";
import { queryClient } from "../../../../lib/queryPersistence";

// The privacy shield's reads and the owner's two writes, through the daemon's privacy routes. Its own composable
// rather than part of useSandboxSettings: the policy is stored off the workspace and only the owner may change it, so
// it has its own route, its own refusal (403 for anyone else) and its own cache entry.

export function usePrivacyShield() {
    const { query, error } = useSandboxQuery(rpcQuery(`privacy.status`));

    const save = useMutation(
        {
            mutationFn: (policy: PrivacyShieldPolicy) => sandboxRpc.privacy.setPolicy(policy),
            // Written into the cache before the request lands, since every switch on the panel reads the policy from it;
            // otherwise a toggle shows its old state for the whole round trip, and a second toggle builds on stale data.
            onMutate: async (policy) => {
                const key = rpcKey(`privacy.status`);
                // A refetch in flight could land after this write and put the pre-click policy back on screen.
                await queryClient.cancelQueries({ queryKey: key });
                const previous = queryClient.getQueryData<PrivacyShieldStatus>(key);
                if (previous !== undefined) {
                    queryClient.setQueryData<PrivacyShieldStatus>(key, { ...previous, policy });
                }
                return { previous };
            },
            // A refused write (a member who is not the owner gets a 403) puts back what was on screen before the press,
            // so no switch claims a policy the daemon did not keep.
            onError: (_error, _policy, context) => {
                if (context?.previous !== undefined) {
                    queryClient.setQueryData<PrivacyShieldStatus>(rpcKey(`privacy.status`), context.previous);
                }
            },
            onSettled: async () => {
                await queryClient.invalidateQueries({ queryKey: rpcKey(`privacy.status`) });
            },
        },
        // Named rather than injected, as useSandboxQuery does: a write can start from a plain handler.
        queryClient,
    );

    const status = computed<PrivacyShieldStatus | undefined>(() => query.data.value);

    return {
        status,
        // Every write sends the whole policy, since the route replaces it; nothing loaded means nothing to build on, so
        // the write is dropped rather than inventing a policy from defaults.
        setPolicy: (change: (policy: PrivacyShieldPolicy) => PrivacyShieldPolicy): void => {
            const current = status.value?.policy;
            if (current !== undefined) {
                save.mutate(change(current));
            }
        },
        isSaving: computed<boolean>(() => save.isPending.value),
        saveError: computed<Error | null>(() => save.error.value),
        isLoading: query.isLoading,
        error,
    };
}

// The gateway's own record of what it did. Read under its route's key, so the daemon's `privacy-log` push refreshes it
// without a poll (queryKeys.ts maps the push to this read).
export function usePrivacyLog() {
    const { query, error } = useSandboxQuery(rpcQuery(`privacy.log`));
    return { entries: computed<PrivacyLedgerEntry[]>(() => query.data.value ?? []), isLoading: query.isLoading, error };
}

// The datasets taught to the shield, and the owner's way to forget one. The agent teaches through its CLI, which this
// panel never does.
export function usePrivacySources() {
    const { query, error } = useSandboxQuery(rpcQuery(`privacy.sources`));

    const forget = useMutation(
        {
            mutationFn: (source: string) => sandboxRpc.privacy.forget({ source }),
            // Both reads move: the list loses a source, and the status's count of learned values drops with it.
            onSettled: async () => {
                await Promise.all([
                    queryClient.invalidateQueries({ queryKey: rpcKey(`privacy.sources`) }),
                    queryClient.invalidateQueries({ queryKey: rpcKey(`privacy.status`) }),
                ]);
            },
        },
        queryClient,
    );

    return {
        sources: computed<PrivacyKnownSource[]>(() => query.data.value ?? []),
        // Resolves either way: the refusal is read from `forgetError`, so the button that pressed it only waits.
        forget: async (source: string): Promise<void> => {
            // allow(silent-catch): the mutation keeps its own error, which `forgetError` shows beside the button.
            await forget.mutateAsync(source).catch(() => undefined);
        },
        forgetError: computed<Error | null>(() => forget.error.value),
        isLoading: query.isLoading,
        error,
    };
}
