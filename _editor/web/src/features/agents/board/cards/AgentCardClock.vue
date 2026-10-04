<script setup lang="ts">
import { providerLabel } from "@intentic/sandbox-contract";
import { Button, type Tip, useDevice } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatWhen } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { sandboxNow } from "../../fleet/sandboxClock";
import { activityIcon, formatElapsed, limitClosed, limitCorner, turnInFlight, watching, watchLine } from "../../fleet/agentStatus";
import { cacheCooling, cacheWarm, warmMark } from "../../fleet/prompt-cache/promptCache";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import AgentCardDate from "./AgentCardDate.vue";

// An agent card's "when" corner: the settled date, or the running elapsed, a watch, a limit or a cache countdown.
// Live clock ticks redraw only this corner; relative dates below tick in their own minute-rate leaf.

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
// Second-rate ticks only for live clocks (turn, watch, limit countdown, warm cache); dates use AgentCardDate.
// On the sandbox's clock: every instant this corner counts to or from is one the sandbox stamped (sandboxClock.ts).
const tick = useNow(() => turnInFlight(props.agent) || watching(props.agent) || limitClosed(props.agent) || cacheWarm(props.agent));
const now = computed(() => sandboxNow(tick.value));
// Shares the card's "when" corner with the running elapsed and the watch countdown; the chip already says what
// happened, this says what comes of it: when the allowance is back, or, for a booked resend or move, when or where it
// goes by itself, which is why a card resting in Active is there (agentStatus.limitCorner). Undefined once nothing is
// booked and the window is open, or the provider gave no instant; the corner then falls back to the ordinary date.
const limit = computed(() => limitCorner(props.agent, now.value));
// Recomputed against the ticking `now`, like the elapsed beside it, so the countdown moves without its own timer.
// Suppressed while a turn is in flight: the running corner already answers "doing what, for how long", and reclaims it
// the moment the turn ends. And yields to a spent allowance, so the corner holds ONE clock: a watch firing into a shut
// window runs nothing (turn-admission holds its words back), so the reset is the next moment the card can move, and
// the watch's countdown comes back with its Stop press once the limit has had its say.
const watch = computed(() => (props.working || limit.value !== undefined ? undefined : watchLine(props.agent, now.value)));
// Its hover from the facts the card holds (whose limit, when it reopens) rather than the provider's refusal sentence;
// the corner says the wait, the hover the instant. A booked resend or move says it goes by itself, so nothing needs
// pressing (and the card offers no press: AgentCard's `resendable`).
const limitTip = computed((): Tip | undefined => {
    const corner = limit.value;
    if (corner === undefined) {
        return undefined;
    }
    const provider = { label: t(`agents.words.provider`), value: providerLabel(props.agent.provider) };
    if (corner.kind === `back`) {
        return {
            title: t(`agents.agentStatus.usageLimit`),
            tone: `warn`,
            rows: [provider, { label: t(`agents.agentCard.reopens`), value: formatWhen(corner.clock.at, now.value) }],
        };
    }
    const at = corner.kind === `resend` && corner.clock !== undefined ? [{ label: t(`agents.agentCard.resendsAt`), value: formatWhen(corner.clock.at, now.value) }] : [];
    return {
        title: corner.kind === `moving` ? t(`agents.agentStatus.movingTo`, { account: corner.account }) : t(`agents.agentCard.resendBooked`),
        tone: `info`,
        rows: [provider, ...at],
        note: t(`agents.agentCard.noPressNeeded`),
    };
});
// Shares that same corner, and yields it: a reset clock and a watch are each a firmer promise about the card than a
// cache that only makes answering cheaper, so this speaks when the corner is otherwise free.
const cooling = computed(() => (watch.value !== undefined || limit.value !== undefined ? undefined : cacheCooling(props.agent, now.value)));
// A hold outranks the cooling clock in that corner: it is the answer to the question the cooling chip asks.
const warm = computed(() => (watch.value !== undefined || limit.value !== undefined || props.working ? undefined : warmMark(props.agent)));
// Either cache mark's hover, closed by what pressing it does, since the press is this corner's own.
const warmTip = computed((): Tip | undefined =>
    warm.value === undefined ? undefined : { ...warm.value.hint, note: t(`agents.promptCache.clickToChange`) },
);
const coolingTip = computed((): Tip | undefined =>
    cooling.value === undefined ? undefined : { ...cooling.value.hint, note: t(`agents.promptCache.clickToKeepWarm`) },
);
</script>

<template>
    <!-- Archived card dates itself by when it left the board, the same "when" slot a running card's elapsed uses. -->
    <span v-if="agent.archivedAt !== undefined" class="shrink-0">
        <AgentCardDate :at="agent.archivedAt" archived />
    </span>
    <!-- Takes the date's slot: "back in 27m" tells the reader something to plan around, unlike "last active". -->
    <span v-else-if="limit !== undefined" class="inline-flex shrink-0 items-center gap-1" v-tooltip.top="limitTip">
        <Icon name="clock" class="shrink-0 text-2xs" />
        <span class="tabular-nums">{{ limit.text }}</span>
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
    <span v-else-if="watch === undefined && !working && agent.updatedAt > 0" class="shrink-0">
        <AgentCardDate :at="agent.updatedAt" />
    </span>

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
            v-tooltip.top="{ title: t(`agents.words.stopWatching`), note: t(`agents.agentCard.chatWontWake`) }"
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
