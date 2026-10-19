import type { GrantRevoke, OwnerGrant, OwnerGrantKind, StandingGrants } from "@intentic/sandbox-contract/schemas/needs";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { rpcKey, rpcPrefix } from "../../../lib/queryKeys";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";

// The yeses still standing (docs/architecture/needs.md): what grant needs widened past a persona or an area, and which
// gated credentials a named person released, by conversation; and, apart from them, the ones that name no conversation
// (a command policy line, an approved hook set, an approved extension). Refreshed with the needs push, since most are the answer
// to a need; with the `grants` runtime push, for a yes a card wrote mid-turn or a purge took (both bound in
// lib/queryKeys.ts, applied by the live events handler); and after a take-back.

export const standingGrantsKey = rpcKey(`needs.grants`);

type StandingConversation = StandingGrants["conversations"][number];

// `enabled` holds the read for a reader the daemon refuses it to (below maintainer), for a caller drawn whoever reads.
export function useStandingGrants(enabled: MaybeRefOrGetter<boolean> = true) {
    const queryClient = useQueryClient();
    const { query, error } = useSandboxQuery({
        queryKey: standingGrantsKey,
        queryFn: () => sandboxRpc.needs.grants(),
        enabled: computed(() => toValue(enabled)),
    });
    const conversations = computed<readonly StandingConversation[]>(() => query.data.value?.conversations ?? []);
    // The yeses that name no conversation, newest first, and the kinds of them this sandbox could not read.
    const ownerWide = computed<readonly OwnerGrant[]>(() => query.data.value?.ownerWide ?? []);
    const unreadable = computed<readonly OwnerGrantKind[]>(() => query.data.value?.unreadable ?? []);
    const revoke = useMutation({
        mutationFn: (grant: GrantRevoke) => sandboxRpc.needs.revokeGrant(grant),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: rpcPrefix(`needs.grants`) }),
    });
    return { conversations, error, ownerWide, revoke, unreadable };
}
