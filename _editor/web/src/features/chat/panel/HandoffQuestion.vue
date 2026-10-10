<script setup lang="ts">
import type { HandoffMode, HandoffOffer } from "@intentic/sandbox-contract";
import { SegmentedControl } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { handoffLine, handoffOptions } from "../run/handoffChoice";

// The pick-up card's second question for a spent allowance, asked the way its first one is (TurnBreakQuestion): how the
// held turn continues once its cache is cold. Carry the session whole, trim its old tool output, or open a fresh session
// from a summary; the sandbox marks the one it suggests and preselects it, and the line beside the pills says what the
// selected way does and costs. The pick is the person's: it holds for the Continue press, a booked move and the reset.

const props = defineProps<{
    offer: HandoffOffer;
    // Shown but not pressable: no sandbox to write to.
    disabled?: boolean;
}>();
const emit = defineEmits<{ choose: [handoff: HandoffMode] }>();

const t = useT();

const options = computed(() => handoffOptions(props.offer));
// Held while the pick is in flight, so the pill moves under the finger; the card's own pick-up takes over once it lands.
const pending = ref<HandoffMode>();
const picked = computed<HandoffMode>({
    get: () => pending.value ?? props.offer.chosen ?? props.offer.suggested,
    set: (next) => {
        pending.value = next;
        emit(`choose`, next);
        pending.value = undefined;
    },
});
const line = computed(() => handoffLine(props.offer, picked.value));
</script>

<template>
    <div v-if="options.length > 1" class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="shrink-0 text-subtle">{{ t(`chat.handoffChoice.label`) }}</span>
        <SegmentedControl
            v-model="picked"
            :options="options"
            size="xs"
            :wrap="true"
            :aria-label="t(`chat.handoffChoice.question`)"
            class="shrink-0"
            :class="{ 'pointer-events-none opacity-60': disabled === true }"
        />
        <!-- Its own line once the row has no room for a sentence beside the pills, rather than a column a word wide. -->
        <span class="min-w-40 flex-1 text-subtle">{{ line }}</span>
    </div>
</template>
