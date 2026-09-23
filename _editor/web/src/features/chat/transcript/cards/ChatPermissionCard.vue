<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import type { CardAnswer } from "../../session/cardReplies";
import ChatCommandBlock from "../../tools/ChatCommandBlock.vue";
import type { ChatMessage } from "../transcript";
import ChatCard from "./ChatCard.vue";
import ChatDecisionButton from "./ChatDecisionButton.vue";
import { permissionStatus } from "./cardStatus";

const t = useT();

const props = defineProps<{ message: ChatMessage; settling: boolean; reply: (answer: CardAnswer) => Promise<void> }>();
const card = computed(() => props.message.permission!);

// Header: the bridge's rendered prompt sentence, else a short noun phrase, else the bare tool name.
const title = computed(() => card.value.title ?? card.value.displayName ?? card.value.toolName);

// Command disclosure, closed by default, per-decision only: the card's title already states the safety judgment.
const commandOpen = ref(false);
</script>

<template>
    <!-- The safety judge's own verdict sentence on this program, never from the gated agent's own words; wraps in full. -->
    <ChatCard icon="shield" prose :title="title" :status="permissionStatus(card)">
        <div class="chat-card-body flex flex-col gap-2">
            <!-- Shown only when it adds to the title (a hard-rule consequence, or a machine name); omitted otherwise. -->
            <span v-if="card.explain" class="text-xs leading-relaxed text-content/85">{{ card.explain }}</span>
            <span v-else-if="card.description" class="text-xs text-content/85">{{ card.description }}</span>

            <template v-if="card.program">
                <!-- Click-to-reveal disclosure, not a hover or tab, so the command stays reachable on touch and keyboard. -->
                <button type="button" :class="ui.textAction(`gap-1 text-2xs`)" :aria-expanded="commandOpen" @click="commandOpen = !commandOpen">
                    <Icon :name="commandOpen ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                    {{ commandOpen ? t(`chat.chatMessageView.hideCommand`) : t(`chat.chatMessageView.showCommand`) }}
                </button>
                <ChatCommandBlock v-if="commandOpen" :program="card.program" />
            </template>

            <span v-if="card.path" class="font-mono text-2xs leading-snug text-subtle">{{ card.path }}</span>
            <span v-if="card.reason" class="text-2xs leading-snug text-subtle">{{
                t(`chat.chatMessageView.requestedBecause`, { reason: card.reason })
            }}</span>
        </div>

        <template v-if="card.status === 'pending'" #actions>
            <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="reply({ kind: 'permission', decision: 'once' })">{{
                t(`chat.chatMessageView.allowOnce`)
            }}</ChatDecisionButton>
            <!-- Secondary tone, since a second filled button beside Allow once would read as a coin flip. -->
            <ChatDecisionButton
                v-if="card.alwaysLabel"
                tone="secondary"
                icon="lock"
                :disabled="settling"
                @click="reply({ kind: 'permission', decision: 'always' })"
                >{{ card.alwaysLabel }}</ChatDecisionButton
            >
            <!-- Like the question card's Dismiss: a refusal with no redirect ends the turn. -->
            <ChatDecisionButton
                tone="secondary"
                icon="times"
                :disabled="settling"
                v-tooltip.bottom="t(`shared.alsoStopsTurn`)"
                @click="reply({ kind: 'permission', decision: 'deny' })"
                >{{ t(`shared.no`) }}</ChatDecisionButton
            >
        </template>
    </ChatCard>
</template>
