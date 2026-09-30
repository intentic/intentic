<script setup lang="ts">
import { MarkdownFigure } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { planParts } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { useMarkdown } from "../../../../lib/markdown/useMarkdown";
import { NEED_ICONS } from "../../../needs/needStatus";
import { useNeeds } from "../../../needs/useNeeds";
import { usePaneView } from "../../panel/useChat-view";
import type { ChatMessage } from "../transcript";
import ChatCard from "./ChatCard.vue";
import ChatDocumentBody from "./ChatDocumentBody.vue";
import { documentDrawn, documentTitled, planStatus } from "./cardStatus";

// The plan and nothing to press: its two answers are the bar's pinned over the composer (ChatWaitingBar), the one place
// they stand. There they are on screen at any scroll position (a long plan's own foot is below the fold on a phone), and
// they carry the notes in the box, which a press down here could not. The shared card props (`settling`, `reply`) are
// not declared, and not let fall onto the card either.
defineOptions({ inheritAttrs: false });

const t = useT();

const props = defineProps<{ message: ChatMessage }>();
const card = computed(() => props.message.plan!);

const { conversation } = usePaneView();
// The body arrives whole with the card, so it never streams.
const plan = useMarkdown(
    () => planParts(card.value.text).body,
    false,
    () => conversation.value.scope.value,
);
const title = computed(() => planParts(card.value.text).title ?? `Proposed plan`);

// What the agent asked people for before presenting this (docs/architecture/needs.md): said on the plan, so approving it
// is read beside what it still waits on, and every one is answered in the same sitting rather than mid-run.
const { openFor } = useNeeds();
const needs = openFor(() => conversation.value.conversationId);
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
        <div v-if="card.status === 'pending' && needs.length > 0" class="chat-card-row flex flex-col gap-1 text-2xs">
            <span class="font-medium text-content">{{ t(`needs.plan.alsoWaiting`, { count: needs.length }, needs.length) }}</span>
            <span v-for="need in needs" :key="need.id" class="flex items-center gap-1.5 text-content/85"><Icon :name="NEED_ICONS[need.subject.kind]" class="text-warning" />{{ need.title }}</span>
            <span class="text-subtle">{{ t(`needs.plan.answerThere`) }}</span>
        </div>
    </ChatCard>
</template>
