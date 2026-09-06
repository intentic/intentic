<script setup lang="ts">
import { computed } from "vue";

/* "A program started this": the mark for a conversation whose first turn was asked for by a control token
 * (AgentSummary.startedBy is `token:<label>`), the CI job, the script, the editor bridge, rather than by a
 * person at a composer. It is the second provenance line beside OriginMark: that one says which automation
 * opened a conversation for an outside message; this says which credential asked for one directly, which is the
 * question somebody asks about a card they do not remember starting.
 *
 * A PERSON's name is deliberately not drawn here. The summary carries it (a member's email), and a shared
 * sandbox may one day want it on the board, but on the owner's own board it would put their address on every
 * card they made, which is the one thing a provenance mark must never be: noise on the ordinary case. */

const props = defineProps<{ startedBy?: string }>();

const TOKEN_PREFIX = `token:`;

const tokenLabel = computed(() => (props.startedBy?.startsWith(TOKEN_PREFIX) === true ? props.startedBy.slice(TOKEN_PREFIX.length) : undefined));
</script>

<template>
    <span
        v-if="tokenLabel !== undefined"
        class="flex min-w-0 items-center gap-1.5 text-2xs text-muted"
        :aria-label="`Started by the control token ${tokenLabel}`"
        v-tooltip.top="`Started by a program holding the control token “${tokenLabel}”`"
    >
        <Icon name="key" class="shrink-0 text-2xs" />
        <span class="shrink-0 font-medium">Token</span>
        <span>·</span>
        <span class="truncate">{{ tokenLabel }}</span>
    </span>
</template>
