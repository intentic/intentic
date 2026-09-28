<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { HoldReason } from "./heldQueue";

/* The one line under a message that did not go out: that it did not, why in a few words, and the way on (the slot). */

const props = defineProps<{
    reason: HoldReason;
    // What the sandbox measured, a hover away rather than three lines of the transcript.
    detail?: string | undefined;
    // Why on the left and the way on at the right, across a card of its own (the quick bar), rather than hung off the
    // right edge under a prompt.
    spread?: boolean;
}>();

const t = useT();

// One key per reason, spelled out so every word here is one the catalog check can find.
const why = computed(() => {
    switch (props.reason) {
        case `memory`:
            return t(`chat.chatHeld.memoryLow`);
        case `stopped`:
            return t(`chat.chatHeld.stopped`);
        default:
            return t(`chat.chatHeld.refused`);
    }
});
</script>

<template>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle" :class="spread ? `justify-between` : `justify-end`">
        <!-- Said once when it appears, which is the moment a message the reader just sent did not go out. -->
        <span role="status" class="flex min-w-0 items-center gap-1.5">
            <!-- Toned only when the sandbox or a provider held it: a stop is the reader's own doing, and needs no flag. -->
            <span class="flex shrink-0 items-center gap-1.5 font-medium" :class="reason === `stopped` ? `text-muted` : `text-warning`">
                <Icon name="pause" class="shrink-0 text-2xs" />{{ t(`chat.chatHeld.notSent`) }}
            </span>
            <span aria-hidden="true">·</span>
            <span
                class="min-w-0"
                :class="detail !== undefined && `cursor-help`"
                v-tooltip.top="detail"
                >{{ why }}</span
            >
        </span>
        <slot />
    </div>
</template>
