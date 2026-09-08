<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { formatElapsed } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { usePaneView } from "../panel/useChat-view";

// The live turn's status line (spinner, activity, elapsed), keyed off the conversation rather than a message bubble, so
// it can render before the turn's first frame opens one. Mounted in two places, ChatMessageView under a live bubble and
// ChatPane before one exists, exactly one of which is ever active.

const { conversation, streaming } = usePaneView();
const { agentById } = useAgents();

// Status words cycled while a turn streams.
const LOADER_WORDS = [
    `Thinking`,
    `Pondering`,
    `Perusing`,
    `Conjuring`,
    `Noodling`,
    `Musing`,
    `Cogitating`,
    `Ruminating`,
    `Percolating`,
    `Brewing`,
    `Tinkering`,
    `Scheming`,
    `Untangling`,
    `Synthesizing`,
];

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
const loaderWord = computed(() =>
    liveSubagents.value > 0
        ? `Waiting on ${liveSubagents.value} subagent${liveSubagents.value === 1 ? `` : `s`}`
        : (LOADER_WORDS[Math.floor(loaderSeconds.value / 2) % LOADER_WORDS.length] ?? `Thinking`),
);

// Replaces the loader word during a provider outage, so a silent turn reads as waiting, not hung.
const providerRetry = computed(() => conversation.value.providerRetry.value);
// Countdown only when the harness reports nextAttemptAt; Codex reports just the attempt number, not a time.
const retryWait = computed(() => {
    const nextAttemptAt = providerRetry.value?.nextAttemptAt;
    return nextAttemptAt === undefined ? `retrying` : `retrying in ${Math.max(0, Math.round((nextAttemptAt - now.value) / 1000))}s`;
});
// 529 is capacity, 429 is the account's rate limit, anything else is a fault; each implies a different fix.
const retryReason = computed(() =>
    providerRetry.value?.status === 529 ? `at capacity` : providerRetry.value?.status === 429 ? `rate-limiting` : `not responding`,
);
</script>

<template>
    <!-- Status line, not a message: sits at the meta tier, sharing the assistant bubble's left padding. -->
    <div class="flex items-center gap-2 self-start rounded-lg bg-overlay px-3 py-2 text-2xs text-muted">
        <Icon name="spinner" class="text-2xs text-link" spin />
        <span v-if="providerRetry"
            >The model provider is {{ retryReason }}: {{ retryWait }}
            <span class="text-subtle">(attempt {{ providerRetry.attempt }}, nothing lost)</span></span
        >
        <span v-else
            >{{ loaderWord }}… <span v-if="loaderElapsed" class="text-subtle">({{ loaderElapsed }})</span></span
        >
    </div>
</template>
