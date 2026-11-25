<script setup lang="ts">
import { Icon, toneTint } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computerAgents } from "../../../../client/sandbox/useDaemonRoutes";

/* "THIS COMPUTER · NOT SANDBOXED", by the composer of a conversation with an agent that runs on this computer itself
   (local/agents/). The chat there is the sandbox's own, row for row, so the one thing that differs has to be said by
   the chat itself, always, not once on a screen the reader has since closed: nothing contains this agent. Its words are
   its own text, never a hover's, in the warning ink a sandbox's chat never wears at rest; what that means at length is
   the consent screen's to say (LocalAgentsConsent.vue). Once, under the box the next message is written in: until
   2026-11-25 it stood in the header too, where it crowded the docked chat's title in a column of a chat's width.
   Draws nothing in a sandbox. */

const t = useT();
</script>

<template>
    <span
        v-if="computerAgents"
        class="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium whitespace-nowrap text-warning"
        :class="toneTint(`warning`, `soft`)"
        data-computer-badge
    >
        <Icon name="exclamation-triangle" class="text-2xs" />
        <span>{{ t(`chat.computer.badge`) }}</span>
    </span>
</template>
