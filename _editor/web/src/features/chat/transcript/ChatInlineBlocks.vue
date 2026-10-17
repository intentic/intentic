<script setup lang="ts">
import { loadChunk } from "@intentic/ui/chunk";
import { defineAsyncComponent } from "vue";
import type { ChatMessage } from "../../../models/conversations/transcript/transcript";

// What an answer draws inline where its reply continues, rather than as a card that waits for an answer: a page the agent
// showed (ChatPageView), a code review's findings (ChatReviewCard). Each loads when a row first holds one.

const ChatPageView = defineAsyncComponent(() => loadChunk(() => import(`./pages/ChatPageView.vue`)));
const ChatReviewCard = defineAsyncComponent(() => loadChunk(() => import(`./review/ChatReviewCard.vue`)));

defineProps<{ message: ChatMessage }>();
</script>

<template>
    <ChatPageView v-if="message.page" :page="message.page" />
    <ChatReviewCard v-if="message.review" :review="message.review" />
</template>
