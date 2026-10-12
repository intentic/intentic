import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { useRunners } from "../../../sandbox/devices/runners/useRunners";
import type { Conversation } from "../../session/conversation";

// The fleet advice for one draft (GET /offload/placement, settings `offload.sessions`): which machine a new chat should
// start on while this one is busy. Read only while the conversation is still a draft on this sandbox with runners to go
// to, since placement latches with its first turn; one query per draft, shared by the composer's strip and the
// placement menu, so both say the same thing.

// Machines' load moves on a scale of seconds; the daemon re-measures a runner at most this often anyway (fleet-facts.ts).
const POLL_MS = 10_000;

// The advice for one conversation, read while `active` says so and the draft could still be placed.
export const useFleetAdvice = (of: MaybeRefOrGetter<Conversation>, active: MaybeRefOrGetter<boolean> = true) => {
    const { ready } = useRunners();
    const open = computed(() => {
        const conversation = toValue(of);
        return toValue(active) && !conversation.registered.value && conversation.box.value === undefined && ready.value.length > 0;
    });
    const { query } = useSandboxQuery({
        ...rpcQuery(
            `offload.placement`,
            () => {
                const conversation = toValue(of);
                return {
                    agent: conversation.selection.provider.value,
                    harness: conversation.selection.harness.value,
                    conversationId: conversation.conversationId,
                };
            },
            { unpersisted: true, background: true },
        ),
        enabled: open,
        refetchInterval: POLL_MS,
    });
    return {
        // Undefined while closed, so a registered conversation never shows a stale verdict from its draft days.
        advice: computed(() => (open.value ? query.data.value : undefined)),
        open,
    };
};
