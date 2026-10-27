<!-- The agent's own words on a card: the case it makes for what it asks, the only words there that are not the sandbox's.
     Quoted, so a reader takes them as a claim to weigh rather than a fact the card states, and read at the card's own
     size, since a decision rests on them. A screen reader hears whose they are. -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";

const t = useT();

defineProps<{ text: string }>();
</script>

<template>
    <p class="min-w-0 text-xs leading-relaxed break-words text-content/85" data-agent-case>
        <span class="sr-only">{{ t(`chat.cardOutcome.agentsCase`) }} </span><q>{{ text }}</q>
    </p>
</template>
