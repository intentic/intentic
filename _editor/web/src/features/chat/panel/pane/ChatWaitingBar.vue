<script setup lang="ts">
import { Button, Icon, type IconName, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { retryHydrate } from "../../run/useChat-sessions";
import { useHeldQueue } from "../../transcript/held/heldQueue";
import { memoryShare, sendAnywayTip } from "../../transcript/held/memoryTip";
import { usePaneView } from "../useChat-view";
import { pendingDecisionOf, type WaitKind } from "./pendingDecision";

// What waits on the reader, pinned right above the composer so it is on screen at any scroll position: the card the
// agent is parked on (or, before this window has drawn it, what the agents list says it waits for), and a message held
// because the sandbox is short of memory. Both sat in the transcript where a reader scrolled elsewhere never saw them:
// a question waited 3 h 36 min, a held message 6 minutes while its writer thought it had gone out.

const props = defineProps<{
    // Whether this reader may answer (a viewer may look, not press).
    canDrive: boolean;
}>();
// The plan's two answers, done by the composer (composerSend), whose box holds the notes either one may carry.
const emit = defineEmits<{ approve: []; keepPlanning: [] }>();

const t = useT();
const { conversation, messages, waitsOn, staged, ending, resumeQueue } = usePaneView();
const root = useTemplateRef<HTMLElement>(`root`);

// A turn a person already ended owes nobody an answer, whatever it is still unwinding.
const decision = computed(() => (ending.value === undefined ? pendingDecisionOf(messages.value, waitsOn.value) : undefined));
const replying = computed(() => {
    const requestId = decision.value?.requestId;
    return requestId !== undefined && conversation.value.requests.isReplying(requestId);
});

const LOOK = {
    plan: { icon: `list-check`, label: () => t(`chat.chatWaitingBar.planWaiting`) },
    question: { icon: `comments`, label: () => t(`chat.chatWaitingBar.questionForYou`) },
    permission: { icon: `shield`, label: () => t(`chat.chatWaitingBar.permissionNeeded`) },
    other: { icon: `exclamation-circle`, label: () => t(`chat.chatWaitingBar.waitingOnYou`) },
} as const satisfies Record<WaitKind, { readonly icon: IconName; readonly label: () => string }>;
const look = computed(() => (decision.value === undefined ? undefined : LOOK[decision.value.kind]));

// The press beside the words: to the card when it is drawn, else a fresh ask for it (a new one even while an earlier ask
// still hangs, as a transcript stuck loading did for minutes), which lands there once drawn.
const showLabel = computed(() => {
    if (decision.value?.requestId === undefined) {
        return t(`chat.chatWaitingBar.showIt`);
    }
    return decision.value.kind === `plan` ? t(`chat.chatWaitingBar.readPlan`) : t(`ui.action.answer`);
});
const scrollToCard = (): void => {
    // A NodeList has no `.at`: spread, so the newest drawn card is the last.
    const cards = [...(root.value?.closest(`.chat-pane`)?.querySelectorAll(`[data-card-live]`) ?? [])];
    cards.at(-1)?.scrollIntoView({ block: `center`, behavior: `smooth` });
};
const fetching = ref(false);
const show = (): void => {
    if (decision.value?.requestId !== undefined) {
        scrollToCard();
        return;
    }
    const chat = conversation.value;
    chat.registered.value = true;
    fetching.value = true;
    retryHydrate(chat);
};
// Asked for from here, it is scrolled to as soon as it arrives.
watch(
    () => decision.value?.requestId,
    (requestId) => {
        if (requestId !== undefined && fetching.value) {
            fetching.value = false;
            void nextTick(scrollToCard);
        }
    },
);

// A message held for memory, said as held with the figures, and the two ways on: send it now, or leave it held, which
// only folds this notice away; the message stays held at the transcript's foot with its own press.
const { held, reason, detail } = useHeldQueue();
const leftHeld = ref<string | undefined>();
const holdKey = computed(() => (held.value && reason.value === `memory` ? `${conversation.value.conversationId}:${detail.value ?? ``}` : undefined));
const memoryShown = computed(() => holdKey.value !== undefined && holdKey.value !== leftHeld.value);
const memoryLine = computed(() => {
    const share = memoryShare(detail.value);
    return share === undefined ? t(`chat.chatWaitingBar.heldMemory`) : t(`chat.chatWaitingBar.heldMemoryShare`, { share });
});
</script>

<template>
    <div v-if="look !== undefined || memoryShown" ref="root" class="flex flex-col gap-2">
        <div
            v-if="decision !== undefined && look !== undefined"
            role="status"
            class="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-primary-500/40 bg-card px-3 py-2 text-2xs shadow-sm"
        >
            <Icon :name="look.icon" class="shrink-0 text-primary-500" />
            <!-- A floor, not `min-w-0`: every press beside it is `shrink-0`, and a squeezed line would lose what is asked. -->
            <span class="min-w-[12rem] flex-1 truncate" v-tooltip.top.overflow="decision.title">
                <span class="font-medium text-content">{{ look.label() }}</span>
                <span v-if="decision.title" class="text-muted"> · {{ decision.title }}</span>
                <span v-else-if="decision.requestId === undefined" class="text-muted"> · {{ t(`chat.chatWaitingBar.fetching`) }}</span>
            </span>
            <span class="flex shrink-0 flex-wrap items-center gap-1">
                <!-- The plan's answers stand here alone, not on its card too: pinned, and beside the box whose notes they carry. -->
                <template v-if="decision.kind === `plan` && decision.requestId !== undefined">
                    <Button size="small" :disabled="!props.canDrive || replying" @click="emit(`approve`)">
                        {{ staged ? t(`chat.chatWaitingBar.approveWithNotes`) : t(`ui.action.approve`) }}
                    </Button>
                    <Button size="small" severity="secondary" :disabled="!props.canDrive || replying" @click="emit(`keepPlanning`)">
                        {{ t(`chat.chatWaitingBar.keepPlanning`) }}
                    </Button>
                </template>
                <Button size="small" severity="secondary" :text="true" @click="show">{{ showLabel }}</Button>
            </span>
        </div>
        <Notice v-if="memoryShown" tone="warning" icon="pause" size="sm" role="status">
            {{ memoryLine }}
            <template #actions>
                <Button size="small" :disabled="!props.canDrive" v-tooltip.top="sendAnywayTip()" @click="resumeQueue()">{{
                    t(`chat.chatHeld.sendAnyway`)
                }}</Button>
                <Button
                    size="small"
                    severity="secondary"
                    :text="true"
                    v-tooltip.top="{ title: t(`chat.chatWaitingBar.wait`), note: t(`chat.chatWaitingBar.waitHint`) }"
                    @click="leftHeld = holdKey"
                    >{{ t(`chat.chatWaitingBar.wait`) }}</Button
                >
            </template>
        </Notice>
    </div>
</template>
