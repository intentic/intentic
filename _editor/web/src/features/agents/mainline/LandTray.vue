<script setup lang="ts">
import type { MainlineLand } from "@intentic/sandbox-contract";
import { timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { openLandConversation, useLandTitle } from "./openLanded";

// THE LANDS UNDER A MAIN LINE CARD, hung the way the fleet board hangs a card's subagents under it (ChildRows): a rule
// down from the card's mark, and one row per land, each opening the conversation that landed it. A project's queue
// holds the lands its next check will measure together, and the running check the lands it is measuring, so the work
// moves from one card's tray to the next as the check picks it up.
//
// Folded past a few, as the fleet board folds finished subagents: the lane stays a board of cards rather than a list of
// every land, and the rest are one press away. A fold of one would be a press to read one line, so one more never folds.

const t = useT();

const {
    lands,
    fold = 5,
    live = false,
    waiting = false,
} = defineProps<{
    lands: readonly MainlineLand[];
    // What the rows are, for a reader who cannot see the rule tying them to the card.
    label: string;
    // How many show before the rest fold.
    fold?: number;
    // Under a card at the live weight, whose mark sits 2px further in.
    live?: boolean;
    // Lands still waiting (a queue) rather than being measured: a quieter mark, and how long each has waited.
    waiting?: boolean;
    // The minute the board reads, so every age on it moves on the same tick.
    minute: number;
}>();

const landTitle = useLandTitle();

const open = ref(false);
const folds = computed(() => lands.length - fold > 1);
const shown = computed(() => (folds.value && !open.value ? lands.slice(0, fold) : lands));
const hidden = computed(() => lands.length - fold);
</script>

<template>
    <div role="group" :aria-label="label" class="flex flex-col border-l border-line pt-1 pl-1" :class="live ? `ml-7.5` : `ml-7`">
        <button
            v-for="land in shown"
            :key="`${land.conversationId}-${land.at}`"
            type="button"
            data-land
            class="ui-row-select flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left max-md:min-h-10"
            @click="openLandConversation(land.conversationId, land.title)"
        >
            <Icon name="circle" class="shrink-0 text-2xs" :class="waiting ? `text-subtle` : `text-link`" />
            <span class="min-w-0 flex-1 truncate text-xs text-content">{{ landTitle(land.conversationId, land.title) }}</span>
            <span v-if="waiting" class="shrink-0 text-2xs tabular-nums text-subtle">{{ timeAgo(land.at, { now: minute }) }}</span>
        </button>
        <!-- The fold, in the rows' own mark column: a chevron where a row has its mark, so the count reads as one more row. -->
        <button
            v-if="folds"
            type="button"
            data-fold
            class="ui-row-select flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-2xs text-subtle max-md:min-h-10"
            :aria-expanded="open"
            @click="open = !open"
        >
            <Icon :name="open ? `chevron-down` : `chevron-right`" class="shrink-0 text-2xs" />
            <span class="min-w-0 flex-1 truncate">{{ open ? t(`ui.action.showFewer`) : t(`agents.mainline.board.more`, { count: hidden }) }}</span>
        </button>
    </div>
</template>
