<script setup lang="ts">
import { formatElapsed } from "@intentic/ui";
import { formatWhen } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import AgentCardDate from "../../../../parts/fleet/AgentCardDate.vue";
import { activityIcon } from "../../../../models/agent-status/agentStatus-meta";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import type { CardClock } from "./cardClock";

// The header corner's "when", one reading per card in one place: how long the turn has run, or how long since the model
// last answered (since it was filed, on an archived card). A running card says it runs by the ticking elapsed and its
// blade (AgentCard), so the corner spends no spinner on it, and what it is doing right now is the glyph's hover: the
// words named a step the reader rarely needs, and spent a row of every running card on it.
// It leads the corner, left of the badges, which keep together. Its hovers open BELOW: the card's hover bar
// (CardHoverBar) floats over the top edge right above this corner.

const { agent, clock, activityText } = defineProps<{
    agent: FleetAgent;
    clock: CardClock;
    activityText: string | undefined;
}>();

const t = useT();
const { corner, now, answered, answeredTip } = clock;
const workingTip = computed((): string => activityText ?? t(`ui.status.working`));
const archivedTip = computed(() =>
    agent.archivedAt === undefined ? undefined : t(`agents.agentCard.archived`, { archivedAt: formatWhen(agent.archivedAt, now.value) }),
);
</script>

<template>
    <!-- The glyph follows the tool the agent itself is using; the elapsed runs from the turn's start. -->
    <span
        v-if="corner === `working`"
        v-tooltip.bottom="workingTip"
        class="inline-flex shrink-0 items-center gap-1 text-2xs font-medium text-link"
        data-card-when="working"
    >
        <Icon :name="activityIcon(agent.activity?.tool)" class="shrink-0 text-2xs" />
        <span class="sr-only">{{ workingTip }}</span>
        <span v-if="agent.startedAt !== undefined" class="tabular-nums">{{ formatElapsed((now - agent.startedAt) / 1000) }}</span>
    </span>
    <!-- Filed away: the box says so, its age counts from when it left the board. -->
    <span
        v-else-if="corner === `archived` && agent.archivedAt !== undefined"
        v-tooltip.bottom="archivedTip"
        class="inline-flex shrink-0 items-center gap-1 text-2xs text-subtle"
        data-card-when="archived"
    >
        <Icon name="box" class="shrink-0 text-2xs" />
        <span class="tabular-nums"><AgentCardDate :at="agent.archivedAt" /></span>
    </span>
    <span v-else-if="corner === `answered`" v-tooltip.bottom="answeredTip" class="shrink-0 text-2xs tabular-nums text-subtle" data-card-when="answered">
        <AgentCardDate :at="answered" />
    </span>
</template>
