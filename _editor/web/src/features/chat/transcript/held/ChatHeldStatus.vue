<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { formatReset, formatWait } from "../../session/usageStatus";
import type { HoldReason } from "./heldQueue";
import { memoryTip } from "./memoryTip";

/* The one line under a message that did not go out: that it did not, why in a few words, and the way on (the slot). A
   scheduled send reads as what it is instead, a message booked for later with the time it goes. */

const props = defineProps<{
    reason: HoldReason;
    // What the sandbox measured (its first sentence), drawn as a hover card of figures rather than three lines of the
    // transcript.
    detail?: string | undefined;
    // When a scheduled send goes by itself (ms).
    until?: number | undefined;
    // Why on the left and the way on at the right, across a card of its own (the quick bar), rather than hung off the
    // right edge under a prompt.
    spread?: boolean;
}>();

const t = useT();

const figures = computed(() => memoryTip(props.detail));

// Ticks only while a scheduled send counts down, so "in about 40 min" stays true.
const now = useNow(() => props.reason === `scheduled` && props.until !== undefined);

// Past this, the clock it goes at reads better than a countdown; under it, the wait alone (pickUpWhen's threshold).
const CLOCK_FROM_MS = 90 * 60 * 1_000;
const sendsWhen = (until: number, at: number): string => {
    const seconds = Math.round(until / 1_000);
    const wait = formatWait(seconds, at);
    return until - at >= CLOCK_FROM_MS ? t(`chat.chatHeld.sendsAtClock`, { clock: formatReset(seconds, at), wait }) : t(`chat.chatHeld.sendsIn`, { wait });
};

// One key per reason, spelled out so every word here is one the catalog check can find.
const why = computed(() => {
    switch (props.reason) {
        case `memory`:
            return t(`chat.chatHeld.memoryLow`);
        case `stopped`:
            return t(`chat.chatHeld.stopped`);
        case `scheduled`:
            // Past its instant, the sandbox is letting it go on its next pass (every few seconds).
            return props.until === undefined || props.until <= now.value ? t(`chat.chatHeld.sendsShortly`) : sendsWhen(props.until, now.value);
        default:
            return t(`chat.chatHeld.refused`);
    }
});
</script>

<template>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle" :class="spread ? `justify-between` : `justify-end`">
        <!-- Said once when it appears, which is the moment a message the reader just sent did not go out. -->
        <span role="status" class="flex min-w-0 items-center gap-1.5">
            <!-- A scheduled send is the reader's own booking, said as one: a clock, no alarm. -->
            <span v-if="reason === `scheduled`" class="flex shrink-0 items-center gap-1.5 font-medium text-muted">
                <Icon name="clock" class="shrink-0 text-2xs" />{{ t(`chat.chatHeld.scheduled`) }}
            </span>
            <!-- Toned only when the sandbox or a provider held it: a stop is the reader's own doing, and needs no flag. -->
            <span v-else class="flex shrink-0 items-center gap-1.5 font-medium" :class="reason === `stopped` ? `text-muted` : `text-warning`">
                <Icon name="pause" class="shrink-0 text-2xs" />{{ t(`chat.chatHeld.notSent`) }}
            </span>
            <span aria-hidden="true">·</span>
            <span class="min-w-0 tabular-nums" :class="figures !== undefined && `cursor-help`" v-tooltip.top="figures">{{ why }}</span>
        </span>
        <slot />
    </div>
</template>
