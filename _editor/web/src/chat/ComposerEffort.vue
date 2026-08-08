<!-- THE REASONING-EFFORT METER — the little ladder of segments beside the model pill, and the word for the rung
     it is on. Two composers draw it (the chat's, and the suggested-session box's), which is why it is a
     component: the two used to carry their own copies of the scale, the lit-segment index, the label lookup AND
     the fill ramp, line for line, down to the `50 + (i / top) * 45` curve — four things that had to be changed in
     two places to stay one control, in files far enough apart that nobody would.

     THE RAMP IS THE POINT. A segment is not on-or-off: the lit ones climb from ~50% brand at Low to ~95% at the
     top, so the ladder reads as "how hard" at a glance rather than as a count of boxes. A copy that lit every
     segment the same colour would look right in a screenshot and wrong in use.

     IT DRAWS NOTHING when the runtime doesn't take an effort — an ACP agent owns its own reasoning settings, and
     OpenCode drops the field entirely (see `capabilities.effort`). Segments there are buttons that change
     nothing, which is worse than no segments. -->
<script setup lang="ts">
import { computed } from "vue";
import type { Conversation } from "../composables/chat/conversation";
import { effortsFor } from "../composables/chat/effortScale";

const {
    conversation,
    disabled = false,
    labelClass = ``,
} = defineProps<{
    conversation: Conversation;
    /** Greyed and inert — the chat composer's controls go quiet under a workflow badge. */
    disabled?: boolean;
    /** Extra classes on the level word, for a composer that drops it in a narrow container. */
    labelClass?: string;
}>();

const { provider, model, thinking, effort, capabilities } = conversation;

const efforts = computed(() => (capabilities.value.effort ? effortsFor(provider.value, model.value, thinking.value) : []));
const effortIndex = computed(() => efforts.value.findIndex((option) => option.value === effort.value));
const effortLabel = computed(() => efforts.value.find((option) => option.value === effort.value)?.label ?? effort.value);
const effortFill = (index: number): string => {
    const top = Math.max(1, efforts.value.length - 1);
    const pct = 50 + (index / top) * 45; // Low ≈ 50% brand → top level ≈ 95% brand
    return `color-mix(in oklab, var(--color-primary-500) ${pct}%, transparent)`;
};
</script>

<template>
    <div v-if="efforts.length > 0" class="flex shrink-0 items-center gap-1.5" role="group" aria-label="Reasoning effort">
        <div class="flex items-center">
            <button
                v-for="(option, index) in efforts"
                :key="option.value"
                type="button"
                class="composer-effort-seg"
                :style="index <= effortIndex ? { backgroundColor: effortFill(index) } : undefined"
                :disabled="disabled"
                @click="conversation.setEffort(option.value)"
                :aria-label="option.label"
                :aria-pressed="effort === option.value"
            ></button>
        </div>
        <span class="text-2xs text-subtle" :class="labelClass">{{ effortLabel }}</span>
    </div>
</template>
