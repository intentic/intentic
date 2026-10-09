<script setup lang="ts">
import type { TurnBreak, TurnBreakPolicy } from "@intentic/sandbox-contract";
import { SegmentedControl } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useAgents } from "../../agents/fleet/useAgents";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import { breakAnswers, effectivePolicy, sandboxPolicy } from "../run/turnBreak";

// One wall's one question, asked where the wall stands in the chat: "Next", the answers as one segmented control, and on
// the same line what the chosen answer will do. Every wall a chat can stop at asks it through here (the pick-up card for
// a spent allowance, an outage or a stopped turn, ChatContinueStrip; the held line for low memory, ChatHeldMessages), so
// the same question reads, moves and saves the same way wherever it is asked. The settings row asks it for the whole
// sandbox (AgentRecovery), the board card's menu for one conversation (AgentSessionMenu), in the same words.

const props = defineProps<{
    ending: TurnBreak;
    conversationId: string;
    // The sibling account a `move` would go to; without one no move is offered (breakAnswers).
    account?: string | undefined;
    // What the answer will do, said beside it; undefined says nothing (an answer to wait, which its own chip says).
    describe: (answer: TurnBreakPolicy) => string | undefined;
    // Shown but not pressable: no sandbox to write to, or no live session to answer for.
    disabled?: boolean;
    // Hung off the right edge, under a held message's line, rather than across a card of its own.
    end?: boolean;
}>();
// Said once the answer is saved, for what only the asker can do about it (start watching for an outage's retry, move
// a held turn now).
const emit = defineEmits<{ chosen: [answer: TurnBreakPolicy] }>();

const t = useT();
const { reachable } = useSandbox();
const { settings } = useSandboxSettings();
const { agentById, setBreakPolicy } = useAgents();

// Each pill's hover: its own name and the one consequence that tells it from the others.
const options = computed(() =>
    breakAnswers(props.ending, props.account).map((answer) => ({
        label: answer.label,
        value: answer.value,
        icon: answer.icon,
        title: { title: answer.label, note: answer.brief },
    })),
);

// Held while a write is in flight, so the pill moves under the finger rather than after the round trip; cleared either
// way, so a refused write snaps back to what the daemon actually holds.
const pending = ref<TurnBreakPolicy>();
// Why the last answer didn't save; about that question only, so a new wall starts without it.
const refused = ref<string>();
watch(
    () => props.ending,
    () => {
        refused.value = undefined;
    },
);

// Read through the same fold every other surface uses (this conversation's override, else the sandbox-wide answer), so
// this control, the settings row and the card's menu cannot disagree about what is armed.
const answer = computed<TurnBreakPolicy>({
    get: () => pending.value ?? effectivePolicy(props.ending, agentById(props.conversationId), settings.value),
    set: (next) => void choose(next),
});
const choose = async (next: TurnBreakPolicy): Promise<void> => {
    const wall = props.ending;
    if (!reachable.value) {
        return;
    }
    pending.value = next;
    refused.value = undefined;
    try {
        // Writing the sandbox's own answer clears the override instead of freezing a copy of a default this conversation
        // would then quietly stop following.
        await setBreakPolicy(props.conversationId, wall, next === sandboxPolicy(wall, settings.value) ? null : next);
        emit(`chosen`, next);
    } catch (error) {
        // Left as it stands: a control that moved on a failed write would claim an automation nobody armed. The snap
        // back alone is easy to miss, so the line says why.
        refused.value = messageOr(error, t(`chat.chatContinueStrip.answerNotSaved`));
    } finally {
        pending.value = undefined;
    }
};

// One clock, stated once, on the line the answer sits on.
const line = computed(() => props.describe(answer.value));
</script>

<template>
    <div v-if="options.length > 1" class="flex flex-wrap items-center gap-x-2 gap-y-1" :class="end === true && `justify-end`">
        <span class="shrink-0 text-subtle">{{ t(`chat.turnBreak.next`) }}</span>
        <SegmentedControl
            v-model="answer"
            :options="options"
            size="xs"
            :wrap="true"
            :aria-label="t(`chat.turnBreak.nextQuestion`)"
            class="shrink-0"
            :class="{ 'pointer-events-none opacity-60': disabled === true || !reachable }"
        />
        <!-- Its own line once the row has no room for a phrase beside the answers, rather than a column a word wide. -->
        <span v-if="line !== undefined" class="min-w-40 flex-1 text-subtle" :class="end === true && `text-right`">{{ line }}</span>
    </div>
    <span v-if="refused !== undefined" role="alert" class="text-2xs text-danger">{{ refused }}</span>
</template>
