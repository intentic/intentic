<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { formatWhen } from "@intentic/ui/format";
import { CLOCK_FROM_MS, currentAction, formatElapsed } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { usePaneView } from "../panel/useChat-view";
import ThinkingRosette from "./ThinkingRosette.vue";
import { useT } from "@intentic/ui/i18n";

// The live turn's status line (spinner, activity, elapsed), keyed off the conversation rather than a message bubble, so
// it can render before the turn's first frame opens one. Mounted in two places, ChatMessageView under a live bubble and
// ChatPane before one exists, exactly one of which is ever active.

const t = useT();

const { conversation, streaming } = usePaneView();
const { agentById } = useAgents();

// Ticking clock behind elapsed/retry countdown, armed only while a turn is live.
const now = useNow(() => streaming.value);

// Start instant comes from the conversation, so a view mounted mid-turn starts its counter midway too. The readout is
// the shared elapsed format, so a turn that runs long reads "9m 12s" rather than "552s".
const loaderElapsed = computed(() => {
    const startedAt = conversation.value.turn.turnStartedAt.value;
    return startedAt === undefined ? undefined : formatElapsed(startedAt, now.value);
});
const agent = computed(() => agentById(conversation.value.conversationId));
// Swaps to "Waiting on N subagents" once the turn is only waiting on children, matching the roster count.
const liveSubagents = computed(() => agent.value?.subagents?.running ?? 0);
// The step the roster reports (tool and target, or the checklist item), so the line says what the agent is doing.
const loaderWord = computed(() => {
    if (liveSubagents.value > 0) {
        return t(`chat.chatTurnStatus.waitingOnSubagents`, { count: liveSubagents.value }, liveSubagents.value);
    }
    return currentAction(agent.value?.activity) ?? t(`chat.chatTurnStatus.thinking`);
});

// Replaces the loader word during a provider outage, so a silent turn reads as waiting, not hung.
const providerRetry = computed(() => conversation.value.turn.providerRetry.value);
// Countdown only when the harness reports nextAttemptAt; Codex reports just the attempt number, not a time. Past
// CLOCK_FROM_MS the instant replaces the countdown, since "165h 22m" is arithmetic and "Tue 15:45" is not.
const retryWait = computed(() => {
    const nextAttemptAt = providerRetry.value?.nextAttemptAt;
    if (nextAttemptAt === undefined) {
        return t(`chat.chatTurnStatus.retrying`);
    }
    return nextAttemptAt - now.value >= CLOCK_FROM_MS
        ? t(`chat.chatTurnStatus.retryingAt`, { when: formatWhen(nextAttemptAt, now.value) })
        : t(`chat.chatTurnStatus.retryingIn`, { wait: formatElapsed(now.value, nextAttemptAt) });
});
// 529 is capacity, 429 is the account's rate limit, anything else is a fault; each implies a different fix.
const retryReason = computed(() =>
    providerRetry.value?.status === 529
        ? t(`chat.chatTurnStatus.atCapacity`)
        : providerRetry.value?.status === 429
          ? t(`chat.chatTurnStatus.rateLimiting`)
          : t(`chat.chatTurnStatus.notResponding`),
);
</script>

<template>
    <!-- Status line, not a message: sits at the meta tier, sharing the assistant bubble's left padding. -->
    <div class="flex max-w-full items-center gap-2 self-start rounded-lg bg-overlay px-3 py-2 text-2xs text-muted">
        <ThinkingRosette class="shrink-0 text-2xs text-link" />
        <span v-if="providerRetry"
            >{{ t(`chat.chatTurnStatus.modelProvider`) }} {{ retryReason }}: {{ retryWait }}
            <span class="text-subtle">{{ t(`chat.chatTurnStatus.attemptNothingLost`, { attempt: providerRetry.attempt }) }}</span></span
        >
        <template v-else>
            <span class="min-w-0 truncate">{{ loaderWord }}…</span>
            <span v-if="loaderElapsed" class="shrink-0 text-subtle">({{ loaderElapsed }})</span>
        </template>
    </div>
</template>
