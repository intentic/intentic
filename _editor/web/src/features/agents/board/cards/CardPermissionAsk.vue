<script setup lang="ts">
import { AnchoredOverlay, Button, useHoverIntent } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import ChatCommandBlock from "../../../chat/tools/ChatCommandBlock.vue";
import { answerableAsk, answerFromBoard, type BoardAnswer } from "../../fleet/boardAnswer";
import type { FleetAgent } from "../../fleet/useAgents-fleet";

// The permission a card's turn waits on, answered where the card is drawn: one row, what it asks on the left and Allow
// once and Skip on the right, as the card's other fact-and-press rows sit. "Approve →" used to open a page with nothing
// to approve, and the chat it now opens may still be loading; the rest of the answers (always, a No that stops the
// turn) stay on the chat's own card, which says what each would do.
//
// A request holding a program carries it, and a pointer resting on the card raises it underneath, highlighted as the
// chat card shows it: nobody should have to allow a command they have not seen. Under the card rather than over it,
// so neither the buttons nor the card's own footer go under the look.

const t = useT();
const props = defineProps<{
    agent: FleetAgent;
    disabled?: boolean;
    // The card this row sits on: its hover raises the command, and the look hangs off its lower edge.
    card?: HTMLElement | undefined;
}>();

const ask = computed(() => answerableAsk(props.agent));
const line = computed(() => (ask.value === undefined || ask.value.ask === `` ? t(`agents.agentStatus.permission`) : ask.value.ask));
const program = computed(() => ask.value?.program);
// A dwell long enough that a pointer crossing the lane raises nothing, and a close grace that carries it over the gap
// into the look, where it can rest to copy the command.
const peek = useHoverIntent({ open: 300, close: 150, warm: 300 });
// Which answer is on its way, so the other is pressed out until the sandbox answers.
const sending = ref<BoardAnswer | undefined>(undefined);
const refused = ref(false);

const answer = async (choice: BoardAnswer): Promise<void> => {
    const waiting = ask.value;
    if (waiting === undefined || sending.value !== undefined) {
        return;
    }
    peek.hide();
    sending.value = choice;
    refused.value = false;
    try {
        refused.value = !(await answerFromBoard(props.agent, waiting, choice));
    } finally {
        sending.value = undefined;
    }
};

const open = computed({
    get: () => peek.shown.value && program.value !== undefined,
    set: (value: boolean) => (value ? peek.show() : peek.hide()),
});
const onEnter = (event: PointerEvent): void => {
    if (event.pointerType === `mouse` && program.value !== undefined) {
        peek.enter();
    }
};
const onLeave = (): void => peek.leave();
// A press anywhere on the card is a decision about it (open it, answer, drag it): the look steps out of its way.
const onPress = (): void => peek.hide();

// Listened on the card itself, which this row does not render.
watch(
    () => props.card,
    (card, _old, onCleanup) => {
        if (card === undefined) {
            return;
        }
        card.addEventListener(`pointerenter`, onEnter);
        card.addEventListener(`pointerleave`, onLeave);
        card.addEventListener(`pointerdown`, onPress);
        onCleanup(() => {
            card.removeEventListener(`pointerenter`, onEnter);
            card.removeEventListener(`pointerleave`, onLeave);
            card.removeEventListener(`pointerdown`, onPress);
            peek.hide();
        });
    },
    { immediate: true },
);
</script>

<template>
    <div v-if="ask !== undefined" class="flex min-w-0 flex-col gap-1">
        <div class="flex min-w-0 items-center gap-2">
            <!-- Dotted under the words when there is a command behind them: the cue that resting on the card shows it. -->
            <p class="flex min-w-0 flex-1 items-center gap-1.5 text-2xs leading-snug text-content" data-permission-ask>
                <Icon name="shield" class="shrink-0 text-2xs text-primary-500" /><span
                    class="truncate"
                    :class="program !== undefined && `underline decoration-subtle decoration-dotted underline-offset-3`"
                    >{{ line }}</span
                >
            </p>
            <div class="flex shrink-0 items-center gap-1">
                <Button size="small" :disabled="disabled || sending !== undefined" class="whitespace-nowrap" @click.stop="answer(`once`)">
                    <Icon :name="sending === `once` ? `spinner` : `check`" :spin="sending === `once`" />{{ t(`chat.chatMessageView.allowOnce`) }}
                </Button>
                <!-- The chat card's "skip this, keep going": this one call refused, the turn left to carry on without it. -->
                <Button
                    size="small"
                    tier="quiet"
                    :disabled="disabled || sending !== undefined"
                    v-tooltip.top="{ title: t(`ui.action.skip`), note: t(`chat.chatMessageView.skipCall`) }"
                    class="whitespace-nowrap"
                    @click.stop="answer(`skip`)"
                >
                    <Icon :name="sending === `skip` ? `spinner` : `forward`" :spin="sending === `skip`" />{{ t(`agents.agentCard.skip`) }}
                </Button>
            </div>
        </div>
        <p v-if="refused" class="text-2xs text-danger">{{ t(`agents.agentCard.answerNotTaken`) }}</p>
        <AnchoredOverlay v-if="program !== undefined" v-model="open" :anchor="card" side="bottom" cross="start" :restore-focus="false">
            <div
                class="flex w-[32rem] max-w-[calc(100vw-2rem)] flex-col gap-2 p-3 text-left"
                data-command-peek
                @pointerenter="peek.cancel()"
                @pointerleave="onLeave"
            >
                <p class="flex min-w-0 items-start gap-1.5 text-xs font-medium leading-snug text-content">
                    <Icon name="shield" class="mt-0.5 shrink-0 text-2xs text-primary-500" /><span class="min-w-0">{{ line }}</span>
                </p>
                <ChatCommandBlock :program="program" />
            </div>
        </AnchoredOverlay>
    </div>
</template>
