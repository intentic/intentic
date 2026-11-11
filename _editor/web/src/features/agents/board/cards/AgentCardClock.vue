<script setup lang="ts">
import { Button, type IconName, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { SelfStart } from "../../../../models/agent-status/agentStatus-clock";
import type { CardClock } from "./cardClock";

// An agent card's closing-row "when": a watch, when it goes again by itself (a limit's resend, a message held for memory
// or booked for later) or a cache countdown. The running elapsed and the settled age are the header corner's
// (AgentCardWhen); which of them speaks is decided once, in cardClock.ts. Live clock ticks redraw only this seat.

const { clock, busy } = defineProps<{
    clock: CardClock;
    // An action of the card's own is in flight, so the watch's stop press is pressed out.
    busy: boolean;
}>();
const emit = defineEmits<{
    unwatch: [];
    // The job a watch waits on sits at a prompt: Stop ends that command, which disarms its watch first.
    stopJob: [jobId: string];
    // Either cache mark was pressed; the card anchors the keep-warm panel on the press.
    warm: [event: MouseEvent];
}>();

const t = useT();
const { mobile } = useDevice();
const { shown, goesTip, warm, warmTip, cooling, coolingTip, watch, prompt, stopsCommand } = clock;

// The glyph says what goes, where the card has a glyph for it, so the words can be only when: a resend wears the card's
// own Send again glyph ("⟳ in 62m", agentStatus-clock's rerunCorner), a move the arrow its "Moved to" line wears.
// Everything else counts on a clock, its verb in its words ("back in 27m", "sends 14:05").
const GLYPHS = { resend: `refresh`, moving: `arrow-right`, back: `clock`, room: `clock`, send: `clock` } as const satisfies Record<SelfStart[`kind`], IconName>;
const glyph = computed(() => GLYPHS[shown.value?.kind ?? `back`]);
</script>

<template>
    <!-- Takes the date's slot: "⟳ in 62m", "sends in 12m", "back in 27m" tell the reader something to plan around, unlike "last active". -->
    <!-- Capped, since the row floors its reading at its whole width (AgentCard's `min-w-max`): "sends after <a title> lands"
         ran past the card's edge, and from the right-hand lane that scrolled the whole board sideways. The hover says it whole. -->
    <span v-if="shown !== undefined" class="inline-flex shrink-0 items-center gap-1" v-tooltip.top="goesTip">
        <Icon :name="glyph" class="shrink-0 text-2xs" />
        <span class="max-w-60 truncate tabular-nums">{{ shown.text }}</span>
    </span>
    <!-- A hold on the cache, running or stopped early: the corner says until when, or since when it went cold. -->
    <button
        v-else-if="warm !== undefined"
        type="button"
        class="inline-flex shrink-0 items-center gap-1 hover:underline"
        :class="warm.cold ? 'text-warning' : 'text-link'"
        v-tooltip.top="warmTip"
        @click.stop="emit(`warm`, $event)"
    >
        <Icon :name="warm.icon" class="shrink-0 text-2xs" />
        <span class="tabular-nums">{{ warm.text }}</span>
    </button>
    <!-- Borrows the date's slot for the last fifth of the cache's life: for that minute or twelve, "answering now is cheap" is worth more than "4m ago", and it hands the slot straight back. -->
    <button
        v-else-if="cooling !== undefined"
        type="button"
        class="inline-flex shrink-0 items-center gap-1 hover:underline"
        :class="cooling.near ? 'font-medium text-link' : 'text-muted'"
        v-tooltip.top="coolingTip"
        @click.stop="emit(`warm`, $event)"
    >
        <Icon name="bolt" class="shrink-0 text-2xs" />
        {{ cooling.text }}<span class="tabular-nums">{{ cooling.countdown }}</span>
    </button>

    <!-- A watch whose command sits at a prompt: what is waiting and for how long, in the watch's slot, with the press that
    ends it. One row of siblings, so the words are the only part that gives way: nested, the glyph and clock were squeezed
    under the press on a narrow card. -->
    <!-- Fills what the line leaves it, words in a size container like the running readout's below, so they never wrap the corner. -->
    <span v-if="prompt !== undefined" class="flex min-w-0 flex-1 items-center gap-1.5 font-medium text-warning" v-tooltip.top="prompt.hint">
        <span class="@container min-w-4 flex-1 truncate text-right"
            ><Icon name="terminal" class="mr-1.5 text-2xs" /><span class="hidden @[4.5rem]:inline">{{
                t(`agents.agentStatus.waitingForInput`)
            }}</span></span
        >
        <span class="shrink-0 tabular-nums">{{ prompt.elapsed }}</span>
        <Button
            size="small"
            tier="quiet"
            class="-my-1.5 shrink-0"
            :aria-label="t(`agents.agentCard.stopCommand`)"
            v-tooltip.top="{ title: t(`agents.agentCard.stopCommand`), note: t(`agents.agentCard.stopCommandNote`) }"
            :disabled="busy"
            @click.stop="emit(`stopJob`, prompt.jobId)"
        >
            {{ t(`ui.action.stop`) }}
        </Button>
    </span>
    <!-- Same slot and grammar as the running tool and the settled date: a card is only ever one of those three things at a time. -->
    <!-- Fills what the line leaves it, words in a size container like the running readout's below: a watch's label names a whole CI run, and sized to that it pushed the corner onto a row of its own. -->
    <span v-else-if="watch !== undefined" class="flex min-w-0 flex-1 items-center gap-1.5">
        <!-- Readout and its hint wrap together, separately from the press beside them. -->
        <span class="flex min-w-0 flex-1 items-center gap-1.5 font-medium text-link" v-tooltip.top="watch.hint">
            <span class="@container min-w-4 flex-1 truncate text-right"
                ><Icon name="eye" class="mr-1.5 text-2xs" /><span class="hidden @[4.5rem]:inline">{{
                    watch.text
                }}</span></span
            >
            <span class="shrink-0 tabular-nums">{{ watch.countdown }}</span>
        </span>
        <!-- The one visible way to disarm a watch; its negative margin keeps the 26px button from making the summary row taller than a card without a watch. Previously the only way was a right-click menu or a drag, neither discoverable from the readout that announces it. -->
        <Button
            size="small"
            tier="quiet"
            class="-my-1.5 shrink-0"
            :aria-label="stopsCommand ? t(`agents.agentCard.stopCommand`) : t(`agents.words.stopWatching`)"
            v-tooltip.top="{ title: stopsCommand ? t(`agents.agentCard.stopCommand`) : t(`agents.words.stopWatching`), note: t(`agents.agentCard.chatWontWake`) }"
            :disabled="busy"
            :class="mobile ? 'opacity-60' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'"
            @click.stop="emit(`unwatch`)"
        >
            {{ t(`ui.action.stop`) }}
        </Button>
    </span>

</template>
