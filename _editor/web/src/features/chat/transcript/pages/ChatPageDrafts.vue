<script setup lang="ts">
import { computed } from "vue";
import { usePaneView } from "../../panel/useChat-view";
import ChatPageDraft from "./ChatPageDraft.vue";

// Every page the live turn is still writing, at the foot of the column where the turn is being written, until the page
// itself lands in the transcript (turnFacts.ts lets the drafts go then).

const { conversation } = usePaneView();
const drafts = computed(() => [...conversation.value.turn.pageDrafts.value.entries()]);
</script>

<template>
    <ChatPageDraft v-for="[callId, draft] in drafts" :key="callId" :draft="draft" />
</template>
