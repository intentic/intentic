<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { answerableAsk, answerFromBoard, type BoardAnswer } from "../../fleet/boardAnswer";
import type { FleetAgent } from "../../fleet/useAgents-fleet";

// The permission a card's turn waits on, answered where the card is drawn: what it asks on one line, then Allow once and
// Skip. "Approve →" used to open a page with nothing to approve, and the chat it now opens may still be loading; the
// rest of the answers (always, a No that stops the turn) stay on the chat's own card, which says what each would do.

const t = useT();
const props = defineProps<{ agent: FleetAgent; disabled?: boolean }>();

const ask = computed(() => answerableAsk(props.agent));
// Which answer is on its way, so the other is pressed out until the sandbox answers.
const sending = ref<BoardAnswer | undefined>(undefined);
const refused = ref(false);

const answer = async (choice: BoardAnswer): Promise<void> => {
    const waiting = ask.value;
    if (waiting === undefined || sending.value !== undefined) {
        return;
    }
    sending.value = choice;
    refused.value = false;
    try {
        refused.value = !(await answerFromBoard(props.agent, waiting, choice));
    } finally {
        sending.value = undefined;
    }
};
</script>

<template>
    <div v-if="ask !== undefined" class="flex min-w-0 flex-col gap-1.5">
        <p class="flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-content">
            <Icon name="shield" class="mt-0.5 shrink-0 text-2xs text-primary-500" /><span class="line-clamp-2 min-w-0">{{
                ask.ask === `` ? t(`agents.agentStatus.permission`) : ask.ask
            }}</span>
        </p>
        <div class="flex flex-wrap items-center gap-1.5">
            <Button size="small" :disabled="disabled || sending !== undefined" class="whitespace-nowrap" @click.stop="answer(`once`)">
                <Icon :name="sending === `once` ? `spinner` : `check`" :spin="sending === `once`" />{{ t(`chat.chatMessageView.allowOnce`) }}
            </Button>
            <!-- The chat card's "skip this, keep going": this one call refused, the turn left to carry on without it. -->
            <Button
                size="small"
                severity="secondary"
                :text="true"
                :disabled="disabled || sending !== undefined"
                v-tooltip.top="{ title: t(`ui.action.skip`), note: t(`chat.chatMessageView.skipCall`) }"
                class="whitespace-nowrap"
                @click.stop="answer(`skip`)"
            >
                <Icon :name="sending === `skip` ? `spinner` : `forward`" :spin="sending === `skip`" />{{ t(`agents.agentCard.skip`) }}
            </Button>
        </div>
        <p v-if="refused" class="text-2xs text-danger">{{ t(`agents.agentCard.answerNotTaken`) }}</p>
    </div>
</template>
