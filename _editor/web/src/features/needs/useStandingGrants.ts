import type { GrantRevoke, StandingGrants } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { rpcKey, rpcPrefix } from "../../lib/queryKeys";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";

// The yeses still standing (docs/architecture/needs.md): what grant needs widened past a persona or an area, and which
// gated credentials a named person released, by conversation. Refreshed with the needs push, since each one is the
// answer to a need, and after a take-back.

export const standingGrantsKey = rpcKey(`needs.grants`);

type StandingConversation = StandingGrants["conversations"][number];

export function useStandingGrants() {
    const queryClient = useQueryClient();
    const { query, error } = useSandboxQuery({ queryKey: standingGrantsKey, queryFn: () => sandboxRpc.needs.grants() });
    const conversations = computed<readonly StandingConversation[]>(() => query.data.value?.conversations ?? []);
    const revoke = useMutation({
        mutationFn: (grant: GrantRevoke) => sandboxRpc.needs.revokeGrant(grant),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: rpcPrefix(`needs.grants`) }),
    });
    return { conversations, error, revoke };
}
