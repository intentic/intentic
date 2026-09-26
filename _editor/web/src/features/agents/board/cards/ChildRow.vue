<script setup lang="ts">
import { type AgentProvider, providerLabel } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import {
    activityLine,
    agentDisplayTitle,
    agentStatusMeta,
    attentionReason,
    formatElapsed,
    laneOf,
    limited,
    onlyOwnerCanAnswer,
    turnWorking,
    watching,
} from "../../fleet/agentStatus";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import { relativeTime } from "../../../chat/models/catalog";
import { markSegments } from "../../review/markSegments";

// One child riding under its parent's card (childFold): how it stands, what it is called, and how long it has worked
// or when it settled. Everything else it has — the model, the branch, the cost, the diff — is its own chat's to say,
// one press away; a row carries only what tells the children apart at a glance. A child asking what only the reader can
// give wears its ask, in the card's own pill, and the row's one press opens its chat, where the ask is answered.

const props = defineProps<{
    agent: FleetAgent;
    // Its chat is on screen, as a card's `selected` means it.
    selected: boolean;
    // The provider the card above it runs on: a child named only when it runs on another one.
    provider: AgentProvider;
    needle: string;
    matchCase: boolean;
}>();
const emit = defineEmits<{ open: [event: MouseEvent]; review: []; menu: [event: MouseEvent] }>();

const t = useT();

const working = computed(() => turnWorking(props.agent));
// What it asks of the reader, in the card chip's word; never in the archive, where every press waits for a restore.
const ask = computed(() => (props.agent.archivedAt === undefined && onlyOwnerCanAnswer(props.agent) ? attentionReason(props.agent) : undefined));
// Settled or stopped rows take the ledger's ink, a step quieter than a receipt card's, since they sit under one; a row
// that asks, or works, keeps the content's.
const quiet = computed(() => ask.value === undefined && laneOf(props.agent) !== `active`);
// Ticks only while it works; a settled row shares the clock without re-ticking.
const now = useNow(() => working.value);
const glyph = computed<{ icon: IconName; spin?: boolean; label: string; class: string }>(() => {
    // An armed watch is why an idle child is in flight at all: its glyph says what it is waiting for, not that it idles.
    if (!working.value && watching(props.agent)) {
        return { icon: `eye`, label: t(`agents.childRows.watching`), class: `text-link` };
    }
    // A spent allowance is nothing broken: the clock it waits on, in muted ink, not the error's triangle.
    if (limited(props.agent)) {
        return { icon: `clock`, label: t(`agents.agentStatus.usageLimit`), class: `text-subtle` };
    }
    const meta = agentStatusMeta(props.agent.status);
    return laneOf(props.agent) === `finished` ? { ...meta, class: `text-subtle` } : meta;
});
const title = computed(() => agentDisplayTitle(props.agent));
const titleRuns = computed(() =>
    markSegments(title.value, props.matchCase ? props.needle : props.needle.toLowerCase(), props.matchCase),
);
// What it is doing right now, the card's own sentence, in the hover of the clock that says for how long.
const doing = computed(() => activityLine(props.agent) ?? t(`ui.status.working`));
const elsewhere = computed(() => (props.agent.provider === props.provider ? undefined : providerLabel(props.agent.provider)));
</script>

<template>
    <button
        type="button"
        class="ui-row-select flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left max-md:min-h-10"
        :class="{ 'ui-row-select-on': selected }"
        @click="emit(`open`, $event)"
        @dblclick="emit(`review`)"
        @contextmenu.prevent.stop="emit(`menu`, $event)"
    >
        <Icon
            :name="glyph.icon"
            :spin="glyph.spin"
            role="img"
            :aria-label="glyph.label"
            v-tooltip.top="agent.failure ?? glyph.label"
            class="shrink-0 text-xs"
            :class="glyph.class"
        />
        <span class="min-w-0 flex-1 truncate text-xs" :class="quiet ? 'text-muted' : 'text-content'">
            <span v-for="(run, at) in titleRuns" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''">{{ run.text }}</span>
        </span>
        <span v-if="elsewhere !== undefined" class="shrink-0 text-2xs text-subtle">{{ elsewhere }}</span>
        <!-- The card's own pill and tone for an ask, so the reader meets the same word here as on any card that asks. -->
        <span v-if="ask !== undefined" class="ui-status-pill shrink-0 bg-warning/15 text-2xs font-semibold text-warning">{{ ask }}</span>
        <span v-if="working && agent.startedAt !== undefined" v-tooltip.top="doing" class="shrink-0 text-2xs font-medium tabular-nums text-link">{{
            formatElapsed(agent.startedAt, now)
        }}</span>
        <span v-else-if="ask === undefined && agent.updatedAt > 0" class="shrink-0 text-2xs text-subtle">{{ relativeTime(agent.updatedAt) }}</span>
    </button>
</template>
