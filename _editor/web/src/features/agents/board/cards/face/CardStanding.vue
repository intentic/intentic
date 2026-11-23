<!-- An agent card's standing in its corner: the word when there is one (why it needs you, that it has news), else the
     resting glyph, which carries its label as a word in its hover. Same pill, same tones, same precedence as a rail row's
     corner (RailCard): one standing, one reading. -->
<script setup lang="ts">
import { type IconName, type Tip, timeAgo } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { StandingChip } from "../../../../../models/agent-status/agentStatus-chips";

const props = defineProps<{
    chip: (StandingChip & { readonly hint?: Tip; readonly family?: true }) | undefined;
    // The resting glyph, when the card draws one (cornerStandingShown, and not a running card's spinner).
    status: { icon: IconName; spin?: boolean; label: string; class: string } | undefined;
}>();

const t = useT();
// "New" already says unopened; "Updated" hides when you last looked, so only that one earns a hover hint: when.
const chipHint = computed(
    (): Tip | undefined =>
        props.chip?.hint ??
        (props.chip?.seenAt === undefined
            ? undefined
            : { title: t(`agents.agentCard.newActivity`), rows: [{ label: t(`agents.agentCard.lastOpened`), value: timeAgo(props.chip.seenAt, { days: true }) }] }),
);
</script>

<template>
    <!-- The word gives way inside its pill (a mini card's pill is held to the card's width), never past the card's edge. -->
    <span v-if="chip !== undefined" v-tooltip.bottom="chipHint" class="ui-status-pill shrink-0 font-semibold" :class="chip.tone"
        ><Icon v-if="chip.family" name="subagents" class="shrink-0 text-2xs" /><span class="truncate">{{ chip.label }}</span></span
    >
    <!-- What the last turn left open is the tile rim's to say (tileRim): the checklist it drew here twice was one fact with two marks. -->
    <Icon
        v-else-if="status !== undefined"
        :name="status.icon"
        :spin="status.spin"
        v-tooltip.bottom="status.label"
        :aria-label="status.label"
        role="img"
        class="shrink-0 text-base"
        :class="status.class"
    />
</template>
