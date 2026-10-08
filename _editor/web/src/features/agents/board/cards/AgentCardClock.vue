<script setup lang="ts">
import { providerLabel } from "@intentic/sandbox-contract";
import { Button, formatElapsed, type Tip, useDevice } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatWhen } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { sandboxNow } from "../../fleet/sandboxClock";
import { activityIcon, limitClosed, limitCorner, promptLine, turnInFlight, watching, watchLine } from "../../fleet/agentStatus";
import { cacheCooling, cacheWarm, warmMark } from "../../fleet/prompt-cache/promptCache";
import { effectivePolicy } from "../../../chat/run/turnBreak";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
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
    // The job a watch waits on sits at a prompt: Stop ends that command, which disarms its watch first.
    stopJob: [jobId: string];
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
// The answer to the limit is read whole (this conversation's own, else the sandbox's), as the card's menu reads it, so the
// corner can say when "Send again" is chosen but nothing is booked to do it.
const { query: settings } = useSandboxQuery(rpcQuery(`settings.get`));
const limit = computed(() => limitCorner(props.agent, now.value, effectivePolicy(`limit`, props.agent, settings.data.value)));
// Recomputed against the ticking `now`, like the elapsed beside it, so the countdown moves without its own timer.
// Suppressed while a turn is in flight: the running corner already answers "doing what, for how long", and reclaims it
// the moment the turn ends. And yields to a spent allowance, so the corner holds ONE clock: a watch firing into a shut
// window runs nothing (turn-admission holds its words back), so the reset is the next moment the card can move, and
// the watch's countdown comes back with its Stop press once the limit has had its say.
const watch = computed(() => (props.working || limit.value !== undefined ? undefined : watchLine(props.agent, now.value)));
// Takes the watch's place when what the watch waits on is a command at a prompt: its countdown promised a wake that the
// command's exit would bring, and that exit will not come by itself. Amber, and its Stop always shown rather than on
// hover, since this is the card's one way forward.
const prompt = computed(() => (watch.value === undefined ? undefined : promptLine(props.agent, now.value)));
// The watch's own Stop ends the commands its watches wait on (useAgentDrag's `unwatch`), so it says so when there are any.
const stopsCommand = computed(() => {
    const armed = new Set((props.agent.watches ?? []).map((entry) => entry.id));
    return (props.agent.jobs ?? []).some((job) => job.endedAt === undefined && job.watch !== undefined && armed.has(job.watch));
});
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
            ...(corner.unbooked === true ? { note: t(`agents.agentCard.resendNotBooked`) } : {}),
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
    <!-- Amber when "Send again" is the answer but nothing is booked to send it: the press is still the reader's. -->
    <span
        v-else-if="limit !== undefined"
        class="inline-flex shrink-0 items-center gap-1"
        :class="limit.kind === `back` && limit.unbooked === true ? 'text-warning' : undefined"
        v-tooltip.top="limitTip"
    >
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

    <!-- A watch whose command sits at a prompt: what is waiting and for how long, in the watch's slot, with the press that
    ends it. One row of siblings, so the words are the only part that gives way: nested, the glyph and clock were squeezed
    under the press on a narrow card. -->
    <!-- Fills what the line leaves it, words in a size container like the running readout's below, so they never wrap the corner. -->
    <span v-if="prompt !== undefined" class="flex min-w-0 flex-1 items-center gap-1.5 font-medium text-warning" v-tooltip.top="prompt.hint">
        <span class="@container min-w-4 flex-1 truncate text-right"
            ><Icon name="terminal" class="mr-1.5 inline-block align-[-0.1em] text-2xs" /><span class="hidden @[4.5rem]:inline">{{
                t(`agents.agentStatus.waitingForInput`)
            }}</span></span
        >
        <span class="shrink-0 tabular-nums">{{ prompt.elapsed }}</span>
        <Button
            size="small"
            severity="secondary"
            :text="true"
            class="shrink-0"
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
                ><Icon name="eye" class="mr-1.5 inline-block align-[-0.1em] text-2xs" /><span class="hidden @[4.5rem]:inline">{{
                    watch.text
                }}</span></span
            >
            <span class="shrink-0 tabular-nums">{{ watch.countdown }}</span>
        </span>
        <!-- The one visible way to disarm a watch; previously only a right-click menu or a drag, neither discoverable from the readout that announces it. -->
        <Button
            size="small"
            severity="secondary"
            :text="true"
            class="shrink-0"
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
                class="mr-1.5 inline-block align-[-0.1em] text-2xs"
            /><span class="hidden @[4.5rem]:inline">{{ activityText ?? t(`ui.status.working`) }}</span></span
        >
        <span v-if="agent.startedAt !== undefined" class="shrink-0 tabular-nums">{{ formatElapsed((now - agent.startedAt) / 1000) }}</span>
    </span>
</template>
