<script setup lang="ts">
import { providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import { Button, formatElapsed, type Tip, useDevice } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatWhen } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { sandboxNow } from "../../../../models/agent-status/sandboxClock";
import { activityIcon } from "../../../../models/agent-status/agentStatus-meta";
import { turnInFlight, watching } from "../../../../models/agent-status/agentStatus-standing";
import { promptLine, selfStart, selfStartTicks, watchLine } from "../../../../models/agent-status/agentStatus-clock";
import { cacheCooling, cacheWarm, warmMark } from "../../../../models/fleet/promptCache";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import AgentCardDate from "../../../../parts/fleet/AgentCardDate.vue";

// An agent card's "when" corner: the settled date, or the running elapsed, a watch, when it goes again by itself (a
// limit's resend, a message held for memory or booked for later) or a cache countdown.
// Live clock ticks redraw only this corner; relative dates below tick in their own minute-rate leaf.

const props = defineProps<{
    agent: FleetAgent;
    working: boolean;
    activityText: string | undefined;
    // An action of the card's own is in flight, so the watch's stop press is pressed out.
    busy: boolean;
    // The card another agent's id names, for "sends after <agent> lands".
    titleOf?: (conversationId: string) => string | undefined;
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
// Second-rate ticks only for live clocks (turn, watch, a self-start's countdown, warm cache); dates use AgentCardDate.
// On the sandbox's clock: every instant this corner counts to or from is one the sandbox stamped (sandboxClock.ts).
const tick = useNow(() => turnInFlight(props.agent) || watching(props.agent) || selfStartTicks(props.agent) || cacheWarm(props.agent));
const now = computed(() => sandboxNow(tick.value));
// When the card goes again by itself, read off the card's own `next` (agentStatus.selfStart): a spent allowance's resend
// or move, or when it is back when nothing carries it on; a message held for memory sent once memory frees; messages
// booked for a time or another agent's land. The chip says why it waits, this says what goes and when, which is also why
// a card resting in Active is there.
const goes = computed(() => selfStart(props.agent, now.value, props.titleOf));
// A held turn or held message takes the corner from the watch, the cache and the date: a watch firing into a shut window
// or a full sandbox runs nothing (turn-admission holds its words back), so the hold's end is the next moment the card
// can move. A message booked for later does not: a watch's wake would run before it, and a live turn's readout speaks
// for the card while it runs, so either takes the corner and the booking has it back once they are done.
const holding = computed(() => goes.value !== undefined && goes.value.kind !== `send`);
// Recomputed against the ticking `now`, like the elapsed beside it, so the countdown moves without its own timer.
// Suppressed while a turn is in flight: the running corner already answers "doing what, for how long", and reclaims it
// the moment the turn ends. The watch's countdown comes back with its Stop press once a hold has had its say.
const watch = computed(() => (props.working || holding.value ? undefined : watchLine(props.agent, now.value)));
const shown = computed(() => (goes.value?.kind === `send` && (props.working || watch.value !== undefined) ? undefined : goes.value));
// Takes the watch's place when what the watch waits on is a command at a prompt: its countdown promised a wake that the
// command's exit would bring, and that exit will not come by itself. Amber, and its Stop always shown rather than on
// hover, since this is the card's one way forward.
const prompt = computed(() => (watch.value === undefined ? undefined : promptLine(props.agent, now.value)));
// The watch's own Stop ends the commands its watches wait on (useAgentDrag's `unwatch`), so it says so when there are any.
const stopsCommand = computed(() => {
    const armed = new Set((props.agent.watches ?? []).map((entry) => entry.id));
    return (props.agent.jobs ?? []).some((job) => job.endedAt === undefined && job.watch !== undefined && armed.has(job.watch));
});
// Its hover from the facts the card holds (whose limit, when it reopens, when a message goes) rather than the provider's
// refusal sentence; the corner says the wait, the hover the instant. Whatever goes by itself says so, so nothing needs
// pressing (and the card offers no press: AgentCard's `resendable`); a limit nothing is booked for says when it is back.
const goesTip = computed((): Tip | undefined => {
    const corner = shown.value;
    if (corner === undefined) {
        return undefined;
    }
    const noPress = t(`agents.agentCard.noPressNeeded`);
    if (corner.kind === `room`) {
        return { title: t(`agents.agentStatus.heldMemory`), tone: `info`, note: noPress };
    }
    if (corner.kind === `send`) {
        const when = corner.after !== undefined ? t(`chat.sendLater.afterLands`, { title: corner.after }) : corner.clock === undefined ? corner.text : formatWhen(corner.clock.at, now.value);
        const many = corner.count > 1 ? [{ label: t(`agents.agentCard.scheduledMessages`), value: corner.count }] : [];
        return { title: t(`chat.chatHeld.scheduled`), tone: `info`, rows: [{ label: t(`chat.composerIntent.sendsAt`), value: when }, ...many], note: noPress };
    }
    const provider = { label: t(`agents.words.provider`), value: providerLabel(props.agent.provider) };
    if (corner.kind === `back`) {
        return {
            title: t(`agents.agentStatus.usageLimit`),
            tone: `warning`,
            rows: [provider, { label: t(`agents.agentCard.reopens`), value: formatWhen(corner.clock.at, now.value) }],
        };
    }
    const at = corner.kind === `resend` && corner.clock !== undefined ? [{ label: t(`agents.agentCard.resendsAt`), value: formatWhen(corner.clock.at, now.value) }] : [];
    return {
        title: corner.kind === `moving` ? t(`agents.agentStatus.movingTo`, { account: corner.account }) : t(`agents.agentCard.resendBooked`),
        tone: `info`,
        rows: [provider, ...at],
        note: noPress,
    };
});
// Shares that same corner, and yields it: a reset clock and a watch are each a firmer promise about the card than a
// cache that only makes answering cheaper, so this speaks when the corner is otherwise free.
const cooling = computed(() => (watch.value !== undefined || holding.value ? undefined : cacheCooling(props.agent, now.value)));
// A hold outranks the cooling clock in that corner: it is the answer to the question the cooling chip asks.
const warm = computed(() => (watch.value !== undefined || holding.value || props.working ? undefined : warmMark(props.agent)));
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
    <!-- Takes the date's slot: "resends 02:00", "sends in 12m", "back in 27m" tell the reader something to plan around, unlike "last active". -->
    <span v-else-if="shown !== undefined" class="inline-flex shrink-0 items-center gap-1" v-tooltip.top="goesTip">
        <Icon name="clock" class="shrink-0 text-2xs" />
        <span class="tabular-nums">{{ shown.text }}</span>
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

    <!-- Same corner as the settled card's date, so the eye finds one readout per card instead of two at different heights. -->
    <!-- Fills what the line leaves it. The words are size-contained, so they never decide whether the corner wraps: they give way, down to the glyph alone, and the hover keeps them whole. -->
    <span v-if="working" class="flex min-w-0 flex-1 items-center gap-1.5 font-medium text-link">
        <!-- A size container, which is what contains the words; below a few characters' room they drop out and the glyph speaks alone, rather than a stub like "B…". -->
        <span v-tooltip.top="activityText" class="@container min-w-4 flex-1 truncate text-right">
            <!-- Inline, inside the clipped words, so it rides next to them when they fit and survives first when they don't. Glyph follows whichever fact leads: running children if any, else the tool the agent itself is using. -->
            <Icon
                :name="(agent.subagents?.running ?? 0) > 0 ? 'users' : activityIcon(agent.activity?.tool)"
                class="mr-1.5 text-2xs"
            /><span class="hidden @[4.5rem]:inline">{{ activityText ?? t(`ui.status.working`) }}</span></span
        >
        <span v-if="agent.startedAt !== undefined" class="shrink-0 tabular-nums">{{ formatElapsed((now - agent.startedAt) / 1000) }}</span>
    </span>
</template>
