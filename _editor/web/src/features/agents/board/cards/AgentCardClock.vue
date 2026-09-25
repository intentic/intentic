<script setup lang="ts">
import { Button, useDevice } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { activityIcon, formatElapsed, limitClosed, limitCountdown, turnInFlight, watching, watchLine } from "../../fleet/agentStatus";
import { cacheCooling, cacheWarm, warmMark } from "../../fleet/promptCache";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import { relativeTime } from "../../../chat/models/catalog";

// An agent card's "when" corner: the settled date, or the running elapsed, a watch, a limit or a cache countdown.
// The only part of the card that reads the ticking clock, so a tick redraws these few nodes and not the card's links.

const props = defineProps<{
    agent: FleetAgent;
    working: boolean;
    activityText: string | undefined;
    // An action of the card's own is in flight, so the watch's stop press is pressed out.
    busy: boolean;
}>();
const emit = defineEmits<{
    unwatch: [];
    // Either cache mark was pressed; the card anchors the keep-warm panel on the press.
    warm: [event: MouseEvent];
}>();

const t = useT();
const { mobile } = useDevice();
// Ticks only while needed (turn, watch, limit countdown, warm cache); a settled card shares the clock without re-ticking.
const now = useNow(() => turnInFlight(props.agent) || watching(props.agent) || limitClosed(props.agent) || cacheWarm(props.agent));
// Recomputed against the ticking `now`, like the elapsed beside it, so the countdown moves without its own timer.
// Suppressed while a turn is in flight: the running corner already answers "doing what, for how long", and reclaims it
// the moment the turn ends.
const watch = computed(() => (props.working ? undefined : watchLine(props.agent, now.value)));
// Shares the card's "when" corner with the running elapsed and the watch countdown; the chip already says what
// happened, this says when.
// Undefined once the window is open or the provider gave no instant; the corner then falls back to the ordinary date.
const limitBackAt = computed(() => limitCountdown(props.agent, now.value));
// Shares that same corner, and yields it: a reset clock and a watch are each a firmer promise about the card than a
// cache that only makes answering cheaper, so this speaks when the corner is otherwise free.
const cooling = computed(() => (watch.value !== undefined || limitBackAt.value !== undefined ? undefined : cacheCooling(props.agent, now.value)));
// A hold outranks the cooling clock in that corner: it is the answer to the question the cooling chip asks.
const warm = computed(() => (watch.value !== undefined || limitBackAt.value !== undefined || props.working ? undefined : warmMark(props.agent)));
</script>

<template>
    <!-- Archived card dates itself by when it left the board, the same "when" slot a running card's elapsed uses. -->
    <span v-if="agent.archivedAt !== undefined" class="shrink-0"
        >{{ t(`agents.agentCard.archived`, { archivedAt: relativeTime(agent.archivedAt) }) }}
    </span>
    <!-- Takes the date's slot: "back at X" tells the reader something to plan around, unlike "last active". -->
    <span
        v-else-if="limitBackAt !== undefined"
        class="inline-flex shrink-0 items-center gap-1"
        v-tooltip.top="agent.failure ?? t(`agents.agentCard.providerRefusedTurnUsage`)"
    >
        <Icon name="clock" class="shrink-0 text-2xs" />
        <span class="tabular-nums">{{ t(`agents.agentCard.back`, { limitBackAt }) }}</span>
    </span>
    <!-- A hold on the cache, running or stopped early: the corner says until when, or since when it went cold. -->
    <button
        v-else-if="warm !== undefined"
        type="button"
        class="inline-flex shrink-0 items-center gap-1 hover:underline"
        :class="warm.cold ? 'text-warning' : 'text-link'"
        v-tooltip.top="warm.hint"
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
        v-tooltip.top="t(`agents.promptCache.coolingHint`, { hint: cooling.hint })"
        @click.stop="emit(`warm`, $event)"
    >
        <Icon name="bolt" class="shrink-0 text-2xs" />
        {{ cooling.text }}<span class="tabular-nums">{{ cooling.countdown }}</span>
    </button>
    <span v-else-if="watch === undefined && !working && agent.updatedAt > 0" class="shrink-0">{{ relativeTime(agent.updatedAt) }}</span>

    <!-- Same slot and grammar as the running tool and the settled date: a card is only ever one of those three things at a time. -->
    <span v-if="watch !== undefined" class="inline-flex min-w-0 items-center gap-1.5">
        <!-- Readout and its hint wrap together, separately from the press beside them. -->
        <span class="inline-flex min-w-0 items-center gap-1.5 font-medium text-link" v-tooltip.top="watch.hint">
            <Icon name="eye" class="shrink-0 text-2xs" />
            <span class="min-w-0 truncate">{{ watch.text }}</span>
            <span class="shrink-0 tabular-nums">{{ watch.countdown }}</span>
        </span>
        <!-- The one visible way to disarm a watch; previously only a right-click menu or a drag, neither discoverable from the readout that announces it. -->
        <Button
            size="small"
            severity="secondary"
            :text="true"
            class="shrink-0"
            :aria-label="t(`agents.words.stopWatching`)"
            v-tooltip.top="t(`agents.agentCard.stopWatchingConversationStays`)"
            :disabled="busy"
            :class="mobile ? 'opacity-60' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'"
            @click.stop="emit(`unwatch`)"
        >
            {{ t(`ui.action.stop`) }}
        </Button>
    </span>

    <!-- Same corner as the settled card's date, so the eye finds one readout per card instead of two at different heights. -->
    <span v-if="working" class="inline-flex min-w-0 items-center gap-1.5 font-medium text-link">
        <!-- Glyph follows whichever fact leads: running children if any, else the tool the agent itself is using. -->
        <Icon :name="(agent.subagents?.running ?? 0) > 0 ? 'users' : activityIcon(agent.activity?.tool)" class="shrink-0 text-2xs" />
        <span class="min-w-0 truncate">{{ activityText ?? t(`ui.status.working`) }}</span>
        <span v-if="agent.startedAt !== undefined" class="shrink-0 tabular-nums">{{ formatElapsed(agent.startedAt, now) }}</span>
    </span>
</template>
