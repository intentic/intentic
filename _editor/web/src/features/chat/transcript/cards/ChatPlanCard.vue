<script setup lang="ts">
import { MarkdownFigure } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { planParts } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { useMarkdown } from "../../../../lib/markdown/useMarkdown";
import { usePaneView } from "../../panel/useChat-view";
import type { CardAnswer } from "../../session/cardReplies";
import type { ChatMessage } from "../transcript";
import ChatCard from "./ChatCard.vue";
import ChatDecisionButton from "./ChatDecisionButton.vue";
import ChatDocumentBody from "./ChatDocumentBody.vue";
import { documentDrawn, documentTitled, planStatus } from "./cardStatus";

const t = useT();

const props = defineProps<{ message: ChatMessage; settling: boolean; reply: (answer: CardAnswer) => Promise<void> }>();
const card = computed(() => props.message.plan!);

const { conversation } = usePaneView();
// The body arrives whole with the card, so it never streams.
const plan = useMarkdown(
    () => planParts(card.value.text).body,
    false,
    () => conversation.value.scope.value,
);
const title = computed(() => planParts(card.value.text).title ?? `Proposed plan`);
</script>

<template>
    <!-- The plan's own heading, not prose; the body below repeats it. -->
    <ChatCard icon="list-check" icon-class="text-link" :title="title" :status="planStatus(card)">
        <div class="md-prose chat-markdown chat-markdown-compact chat-card-body">
            <template v-for="(part, index) in plan" :key="index">
                <div v-if="part.kind === `html`" class="md-part" v-html="part.html"></div>
                <MarkdownFigure v-else :figure="part.figure" />
            </template>
        </div>
        <!-- Shown only when the model wrote the plan to a file and summarized it in the adjacent prose (agent.ts). -->
        <ChatDocumentBody
            v-if="card.document"
            :document="card.document"
            foldable
            in-card
            :open="!documentDrawn(message, card.document)"
            :titled="documentTitled(title, card.document)"
            max-height="min(58dvh, 40rem)"
            class="chat-card-doc-top-rule chat-card-doc-bottom-rule"
        />
        <template v-if="card.status === 'pending'" #actions>
            <!-- Single approval, not a posture menu: approving a plan approves the work inside the isolation boundary. -->
            <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="reply({ kind: 'plan', approve: true })">{{
                t(`ui.action.approve`)
            }}</ChatDecisionButton>
            <ChatDecisionButton tone="secondary" icon="pencil" :disabled="settling" @click="reply({ kind: 'plan', approve: false })">{{
                t(`chat.chatMessageView.noKeepPlanning`)
            }}</ChatDecisionButton>
        </template>
    </ChatCard>
</template>
