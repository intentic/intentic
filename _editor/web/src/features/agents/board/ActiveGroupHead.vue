<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { countdownTo } from "../../../models/agent-status/agentStatus-clock";
import { sandboxNow } from "../../../models/agent-status/sandboxClock";
import { ANY_MOMENT } from "../../../models/fleet/board/activePhase";
import { type LaneGroup, toggleFold } from "./view/laneGroups";

// The head of one of the Active lane's groups (activePhase.ts): its name, and a press that folds it. Quiet type over the
// cards, a step under the lane's own header, no band or box. No count while open, since its cards are the tally; folded,
// it says how many it holds and, for Up next, when the first of them goes, which is the one fact the folded cards'
// corners would have answered.

const props = defineProps<{
    group: LaneGroup;
    // The lane's first group, which sits under the lane's header rather than under another group's cards.
    first: boolean;
}>();

const t = useT();

const label = computed(() => {
    switch (props.group.key) {
        case `working`:
            return t(`agents.activeGroups.working`);
        case `next`:
            return t(`agents.activeGroups.next`);
        case `draft`:
            return t(`agents.activeGroups.drafts`);
        default:
            return ``;
    }
});

// Ticks only while it counts to a time, at the minute grain that time is written in: "due now" for a memory hold
// (ANY_MOMENT) never changes.
const tick = useNow(() => props.group.folded && props.group.goesAt > ANY_MOMENT && Number.isFinite(props.group.goesAt), 30_000);
const when = computed(() => {
    if (!props.group.folded || !Number.isFinite(props.group.goesAt)) {
        return undefined;
    }
    const clock = countdownTo(props.group.goesAt, sandboxNow(tick.value), true);
    if (clock === undefined) {
        return t(`agents.activeGroups.firstDue`);
    }
    return clock.wait ? t(`agents.activeGroups.firstIn`, { when: clock.text }) : t(`agents.activeGroups.firstAt`, { when: clock.text });
});
</script>

<template>
    <!-- Pulled toward the group it heads (`-mb-2` against the lane's gap), and parted from the group above it by more
         than a card is from a card. -->
    <component
        :is="group.foldable ? `button` : `div`"
        :type="group.foldable ? `button` : undefined"
        :aria-expanded="group.foldable ? !group.folded : undefined"
        class="-mb-2 flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-2xs text-muted"
        :class="[first ? `` : `mt-3`, group.foldable ? `transition-colors hover:text-content` : ``]"
        @click="group.foldable && toggleFold(group.key)"
    >
        <span class="shrink-0 font-semibold">{{ label }}</span>
        <span v-if="group.folded" class="shrink-0 tabular-nums text-subtle">{{ group.cards.length }}</span>
        <span v-if="when !== undefined" class="min-w-0 truncate text-subtle">· {{ when }}</span>
        <!-- Rotation, not an icon swap, as every disclosure in the app turns (DisclosureRow). -->
        <Icon
            v-if="group.foldable"
            name="chevron-right"
            class="ml-auto shrink-0 text-2xs text-subtle transition-transform"
            :class="group.folded ? `` : `rotate-90`"
            aria-hidden="true"
        />
    </component>
</template>
