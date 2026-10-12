import type {
    PrivacyDictionary,
    PrivacyImagePair,
    PrivacyKnownSource,
    PrivacyLedgerEntry,
    PrivacyShieldPolicy,
    PrivacyShieldStatus,
} from "@intentic/sandbox-contract";
import { keepPreviousData, useMutation } from "@tanstack/vue-query";
import { useSettled } from "@intentic/ui/async";
import { computed, type Ref } from "vue";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { rpcKey } from "../../../../lib/queryKeys";
import { queryClient } from "../../../../lib/queryPersistence";
import { optimisticUpdate, restoreChanged } from "../../../../lib/optimistic";

// The privacy shield's reads and the owner's two writes, through the daemon's privacy routes. Its own composable
// rather than part of useSandboxSettings: the policy is stored off the workspace and only the owner may change it, so
// it has its own route, its own refusal (403 for anyone else) and its own cache entry.

export function usePrivacyShield() {
    const { query, error } = useSandboxQuery(rpcQuery(`privacy.status`));

    const save = useMutation(
        {
            // Written into the cache before the request lands, since every switch on the panel reads the policy from it;
            // otherwise a toggle shows its old state for the whole round trip, and a second toggle builds on stale data.
            // A refused write (a member who is not the owner gets a 403) takes back the switches this press moved, so
            // no switch claims a policy the daemon did not keep, and leaves a second press still in flight standing.
            // Re-read either way.
            mutationFn: (policy: PrivacyShieldPolicy) =>
                optimisticUpdate(
                    rpcKey(`privacy.status`),
                    (status: PrivacyShieldStatus) => ({ ...status, policy }),
                    () => sandboxRpc.privacy.setPolicy(policy),
                    { settle: true, undo: (current, before) => ({ ...current, policy: restoreChanged(policy)(current.policy, before.policy) }), client: queryClient },
                ),
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
        // The same write, for a press whose next step needs the daemon to hold the policy first (a grant, then the send it
        // lets through); rejects with the daemon's refusal, and does nothing while nothing is loaded.
        updatePolicy: async (change: (policy: PrivacyShieldPolicy) => PrivacyShieldPolicy): Promise<void> => {
            const current = status.value?.policy;
            if (current !== undefined) {
                await save.mutateAsync(change(current));
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

// The values behind the tokens the activity shows, read from the vault for the owner alone: anybody else is refused
// (403) and the page shows the tokens by themselves. Memory only, so no value reaches the persisted mirror, and never
// retried, since a refusal does not change by asking again. The previous answer stays while a new token is asked about.
export function usePrivacyReveal(tokens: Ref<readonly string[]>) {
    const { query } = useSandboxQuery({
        ...rpcQuery(`privacy.reveal`, () => ({ tokens: [...tokens.value] }), { unpersisted: true }),
        enabled: computed(() => tokens.value.length > 0),
        retry: false,
        placeholderData: keepPreviousData,
    });
    return {
        values: computed<Readonly<Record<string, string>>>(() => query.data.value ?? {}),
        refused: computed<boolean>(() => query.error.value !== null),
    };
}

// One image the shield painted over, as it was and as it left, for the owner peeking at a log row: asked for only once a
// row is opened, since each answer is two whole pictures. Memory only and never retried, as the values are: the picture
// before holds them, and a refusal (anybody but the owner) or an image no longer kept does not change by asking again.
export function usePrivacyImage(id: Ref<string | undefined>) {
    const { query } = useSandboxQuery({
        ...rpcQuery(`privacy.image`, () => ({ id: id.value ?? `` }), { unpersisted: true }),
        enabled: computed(() => id.value !== undefined),
        retry: false,
        staleTime: Infinity,
    });
    return {
        pair: computed<PrivacyImagePair | undefined>(() => query.data.value),
        isLoading: query.isLoading,
        failed: computed<boolean>(() => query.error.value !== null),
    };
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

// How long typing must pause before the dictionary is asked about what was typed.
const DICTIONARY_DEBOUNCE_MS = 200;

// The name lists the shield finds names by, and what they hold for a word or the start of one. The lists alone while
// the query is empty; the previous answer stays on screen while the next one is fetched, so the words do not blink out
// between keystrokes. Memory only: one entry per query typed is nothing worth keeping across reloads.
export function usePrivacyDictionary(query: Ref<string>, debounceMs = DICTIONARY_DEBOUNCE_MS) {
    const settled = useSettled(query, debounceMs, { trim: true });

    const { query: read, error } = useSandboxQuery({
        ...rpcQuery(`privacy.dictionary`, () => (settled.value === `` ? {} : { query: settled.value }), { unpersisted: true }),
        placeholderData: keepPreviousData,
    });
    return {
        dictionary: computed<PrivacyDictionary | undefined>(() => read.data.value),
        // The query the answer on screen was asked for, which trails what is typed by the debounce.
        answered: settled,
        isLoading: read.isLoading,
        isFetching: read.isFetching,
        error,
    };
}
