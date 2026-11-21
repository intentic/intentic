<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { countdownTo } from "../../../models/agent-status/agentStatus-clock";
import { sandboxNow } from "../../../models/agent-status/sandboxClock";
import { ANY_MOMENT } from "../../../models/fleet/board/activePhase";
import { type LaneGroup, toggleFold } from "./view/laneGroups";

// The head of one of the Active lane's waiting groups (activePhase.ts): its name on a hairline drawn inside the gap that
// already parts one group from the next, so it takes no row of its own, and a press that folds the group. Working has
// none (laneGroups.ts): it is always first, right under the lane's own header. No count while open, since its cards are
// the tally; folded, it says how many it holds and, for Up next, when the first of them goes, which is the one fact the
// folded cards' corners would have answered.

const props = defineProps<{
    group: LaneGroup;
    // The lane's first group, which sits under the lane's header rather than under another group's cards.
    first: boolean;
}>();

const t = useT();

const label = computed(() => {
    switch (props.group.key) {
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
    <!-- Sunk into the lane's gaps (`-mt-3` / `-mb-3`) so the groups stand only a little further apart than two cards
         do; the first keeps its top margin, since above it is the lane's header, not a gap. Folded with no cards
         shown, it leaves its bottom margin alone so adjacent headers or the lane's end do not collide. -->
    <component
        :is="group.foldable ? `button` : `div`"
        :type="group.foldable ? `button` : undefined"
        :aria-expanded="group.foldable ? !group.folded : undefined"
        class="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-2xs text-muted"
        :class="[
            first ? `` : `-mt-3`,
            group.shown.length > 0 ? `-mb-3` : ``,
            group.foldable ? `transition-colors hover:text-content` : ``,
        ]"
        @click="group.foldable && toggleFold(group.key)"
    >
        <span class="shrink-0 font-semibold">{{ label }}</span>
        <span v-if="group.folded" class="shrink-0 tabular-nums text-subtle">{{ group.cards.length }}</span>
        <span v-if="when !== undefined" class="min-w-0 truncate text-subtle">· {{ when }}</span>
        <span class="h-px min-w-4 flex-1 bg-line" aria-hidden="true" />
        <!-- Rotation, not an icon swap, as every disclosure in the app turns (DisclosureRow). -->
        <Icon
            v-if="group.foldable"
            name="chevron-right"
            class="shrink-0 text-2xs text-subtle transition-transform"
            :class="group.folded ? `` : `rotate-90`"
            aria-hidden="true"
        />
    </component>
</template>
