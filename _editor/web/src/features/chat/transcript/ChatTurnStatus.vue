<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { formatElapsed } from "../../agents/fleet/agentStatus";
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

// Status words cycled while a turn streams. Keys, not words: the list is read through `t` at render time, so the
// cycle follows the language instead of freezing the English it was written in.
const LOADER_WORDS = [
    `thinking`,
    `pondering`,
    `perusing`,
    `conjuring`,
    `noodling`,
    `musing`,
    `cogitating`,
    `ruminating`,
    `percolating`,
    `brewing`,
    `tinkering`,
    `scheming`,
    `untangling`,
    `synthesizing`,
] as const;

// Ticking clock behind elapsed/retry countdown, armed only while a turn is live.
const now = useNow(() => streaming.value);

// Start instant comes from the conversation, so a view mounted mid-turn starts its counter midway too.
const loaderSeconds = computed(() => {
    const startedAt = conversation.value.turnStartedAt.value;
    return startedAt === undefined ? 0 : Math.max(0, Math.floor((now.value - startedAt) / 1000));
});
// The readout itself is the shared elapsed format, so a turn that runs long reads "9m 12s" rather than "552s".
const loaderElapsed = computed(() => {
    const startedAt = conversation.value.turnStartedAt.value;
    return startedAt === undefined ? undefined : formatElapsed(startedAt, now.value);
});
// Swaps to "Waiting on N subagents" once the turn is only waiting on children, matching the roster count.
const liveSubagents = computed(() => agentById(conversation.value.conversationId)?.subagents?.running ?? 0);
const loaderWord = computed(() => {
    if (liveSubagents.value > 0) {
        return t(`chat.chatTurnStatus.waitingOnSubagents`, { count: liveSubagents.value }, liveSubagents.value);
    }
    const word = LOADER_WORDS[Math.floor(loaderSeconds.value / 2) % LOADER_WORDS.length] ?? `thinking`;
    return t(`chat.chatTurnStatus.loader.${word}`);
});

// Replaces the loader word during a provider outage, so a silent turn reads as waiting, not hung.
const providerRetry = computed(() => conversation.value.providerRetry.value);
// Countdown only when the harness reports nextAttemptAt; Codex reports just the attempt number, not a time.
const retryWait = computed(() => {
    const nextAttemptAt = providerRetry.value?.nextAttemptAt;
    return nextAttemptAt === undefined
        ? t(`chat.chatTurnStatus.retrying`)
        : t(`chat.chatTurnStatus.retryingIn`, { seconds: Math.max(0, Math.round((nextAttemptAt - now.value) / 1000)) });
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
    <div class="flex items-center gap-2 self-start rounded-lg bg-overlay px-3 py-2 text-2xs text-muted">
        <ThinkingRosette class="text-2xs text-link" />
        <span v-if="providerRetry"
            >{{ t(`chat.chatTurnStatus.modelProvider`) }} {{ retryReason }}: {{ retryWait }}
            <span class="text-subtle">{{ t(`chat.chatTurnStatus.attemptNothingLost`, { attempt: providerRetry.attempt }) }}</span></span
        >
        <span v-else
            >{{ loaderWord }}… <span v-if="loaderElapsed" class="text-subtle">({{ loaderElapsed }})</span></span
        >
    </div>
</template>
