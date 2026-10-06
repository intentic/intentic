import { isOpenNeed, type Need, type NeedAnswer } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { rpcKey, rpcPrefix } from "../../lib/queryKeys";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";

// What agents are waiting on people for (docs/architecture/needs.md), read once for the whole sandbox and kept fresh by
// the daemon's push of `.intentic/records/needs.json` (the `needs` key). One read serves every card, the conversation's
// strip, the board and the inbox, so answering a need in any of them moves it in all.

export const needsKey = rpcKey(`needs.list`, {});

const fetchNeeds = async (): Promise<readonly Need[]> => (await sandboxRpc.needs.list({})).needs;

export function useNeeds() {
    const queryClient = useQueryClient();
    const { query, error } = useSandboxQuery({ queryKey: needsKey, queryFn: fetchNeeds });
    const needs = computed<readonly Need[]>(() => query.data.value ?? []);
    // Every answer moves the one list; the card that answered it reads the new state from there.
    const settled = (): Promise<void> => queryClient.invalidateQueries({ queryKey: rpcPrefix(`needs.list`) });

    const answer = useMutation({
        mutationFn: ({ id, answer: reply }: { id: string; answer: NeedAnswer }) => sandboxRpc.needs.answer({ id, answer: reply }),
        onSuccess: settled,
    });
    // The value goes to the daemon's secret store through its own route and is never kept here past the call.
    const provideSecret = useMutation({
        mutationFn: ({ id, value }: { id: string; value: string }) => sandboxRpc.needs.provideSecret({ id, value }),
        onSuccess: settled,
    });

    return {
        needs,
        error,
        isLoading: query.isLoading,
        byId: (id: string): Need | undefined => needs.value.find((need) => need.id === id),
        open: computed(() => needs.value.filter(isOpenNeed)),
        openFor: (conversationId: MaybeRefOrGetter<string | undefined>) =>
            computed(() => needs.value.filter((need) => need.conversationId === toValue(conversationId) && isOpenNeed(need)).sort((left, right) => left.createdAt - right.createdAt)),
        answer,
        provideSecret,
    };
}
