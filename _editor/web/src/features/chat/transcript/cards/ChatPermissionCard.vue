<script setup lang="ts">
import type { ChildMove, ChildRun } from "@intentic/sandbox-contract";
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { providerDisplayLabel } from "../../accounts/providerCatalog";
import type { CardAnswer } from "../../session/cardReplies";
import ChatCommandBlock from "../../tools/ChatCommandBlock.vue";
import type { ChatMessage } from "../transcript";
import ChatCard from "./ChatCard.vue";
import ChatChildAgentAsk from "./ChatChildAgentAsk.vue";
import ChatDecisionButton from "./ChatDecisionButton.vue";
import { permissionStatus } from "./cardStatus";

const t = useT();

const props = defineProps<{ message: ChatMessage; settling: boolean; reply: (answer: CardAnswer) => Promise<void> }>();
const card = computed(() => props.message.permission!);

// The child-agent gate's request carries the child it is about; every other permission ask carries none.
const child = computed(() => card.value.child);
const pending = computed(() => card.value.status === `pending`);
// The owner's pick for a start, held here until the allow carries it; a settled card reads what started off its own row.
const staged = ref<ChildRun | undefined>(undefined);
const livePick = computed(() => (pending.value ? staged.value : undefined));

// A child-agent ask names its move in the header and on the allow, as the daemon's own title does.
const childTitle = (move: ChildMove, provider: string): string => {
    switch (move) {
        case `spawn`:
            return t(`chat.chatChildAgentAsk.spawnTitle`, { provider });
        case `send`:
            return t(`chat.chatChildAgentAsk.sendTitle`, { provider });
        case `answer`:
            return t(`chat.chatChildAgentAsk.answerTitle`, { provider });
    }
};
const childVerb = (move: ChildMove): string => {
    switch (move) {
        case `spawn`:
            return t(`chat.chatChildAgentAsk.spawn`);
        case `send`:
            return t(`chat.chatChildAgentAsk.send`);
        case `answer`:
            return t(`chat.chatChildAgentAsk.answer`);
    }
};

// Header: the bridge's rendered prompt sentence, else a short noun phrase, else the bare tool name. A child-agent ask is
// titled here instead, off the provider that would actually run, which the owner may just have changed.
const title = computed(() => {
    const about = child.value;
    if (about !== undefined) {
        return childTitle(about.move, providerDisplayLabel((livePick.value ?? about).provider));
    }
    return card.value.title ?? card.value.displayName ?? card.value.toolName;
});
const allowLabel = computed(() => (child.value === undefined ? t(`chat.chatMessageView.allowOnce`) : childVerb(child.value.move)));

// Command disclosure, closed by default, per-decision only: the card's title already states the safety judgment.
const commandOpen = ref(false);

// Allowing a start carries the owner's pick with it, when there is one; the daemon starts the child on that instead.
const allow = (): Promise<void> => {
    const pick = livePick.value;
    return props.reply(pick === undefined ? { kind: `permission`, decision: `once` } : { kind: `permission`, decision: `once`, child: pick });
};
</script>

<template>
    <!-- The safety judge's own verdict sentence on this program, never from the gated agent's own words; wraps in full. -->
    <ChatCard icon="shield" prose :title="title" :status="permissionStatus(card)">
        <div class="chat-card-body flex flex-col gap-2">
            <ChatChildAgentAsk
                v-if="child"
                :ask="child"
                :staged="livePick"
                :repointable="pending && child.move === `spawn`"
                :disabled="settling"
                @repoint="staged = $event"
            />

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

        <template v-if="pending" #actions>
            <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="allow">{{ allowLabel }}</ChatDecisionButton>
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
                v-tooltip.bottom="t(`chat.words.alsoStopsTurn`)"
                @click="reply({ kind: 'permission', decision: 'deny' })"
                >{{ t(`ui.action.no`) }}</ChatDecisionButton
            >
        </template>
    </ChatCard>
</template>
