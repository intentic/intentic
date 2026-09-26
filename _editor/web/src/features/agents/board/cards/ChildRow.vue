<script setup lang="ts">
import { type AgentProvider, providerLabel } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { activityLine, agentDisplayTitle, agentStatusMeta, formatElapsed, laneOf, turnWorking, watching } from "../../fleet/agentStatus";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import { relativeTime } from "../../../chat/models/catalog";
import { markSegments } from "../../review/markSegments";
import type { IdMatch } from "../idMatch";

// One child riding under its parent's card (childFold): how it stands, what it is called, and how long it has worked
// or when it settled. Everything else it has — the model, the branch, the cost, the diff — is its own chat's to say,
// one press away; a row carries only what tells the children apart at a glance. Nothing here asks for anything, since
// a child that asks keeps a card of its own, so the row has one press, and it opens the child.

const props = defineProps<{
    agent: FleetAgent;
    // Its chat is on screen, as a card's `selected` means it.
    selected: boolean;
    // The provider the card above it runs on: a child named only when it runs on another one.
    provider: AgentProvider;
    needle: string;
    matchCase: boolean;
    // The filter named this child by its id, or a piece of it (idMatch.ts), as a card's `idMatch` means it.
    idMatch?: IdMatch;
}>();
const emit = defineEmits<{ open: [event: MouseEvent]; review: []; menu: [event: MouseEvent] }>();

const t = useT();

const working = computed(() => turnWorking(props.agent));
// Settled rows take the ledger's ink, a step quieter than a receipt card's, since they sit under one.
const settled = computed(() => laneOf(props.agent) === `finished`);
// Ticks only while it works; a settled row shares the clock without re-ticking.
const now = useNow(() => working.value);
const glyph = computed<{ icon: IconName; spin?: boolean; label: string; class: string }>(() => {
    // An armed watch is why an idle child is in flight at all: its glyph says what it is waiting for, not that it idles.
    if (!working.value && watching(props.agent)) {
        return { icon: `eye`, label: t(`agents.childRows.watching`), class: `text-link` };
    }
    const meta = agentStatusMeta(props.agent.status);
    return settled.value ? { ...meta, class: `text-subtle` } : meta;
});
const title = computed(() => agentDisplayTitle(props.agent));
const titleRuns = computed(() =>
    markSegments(title.value, props.matchCase ? props.needle : props.needle.toLowerCase(), props.matchCase),
);
// The piece of its id the filter matched, drawn after the title, since nothing else on a row says why it is there. Named
// whole, the row wears the halo instead: a row has no room to spend on an id the reader just typed out in full.
const idRuns = computed(() =>
    props.idMatch === undefined || props.idMatch.exact ? undefined : markSegments(props.idMatch.text, props.idMatch.mark),
);
// What it is doing right now, the card's own sentence, in the hover of the clock that says for how long.
const doing = computed(() => activityLine(props.agent) ?? t(`ui.status.working`));
const elsewhere = computed(() => (props.agent.provider === props.provider ? undefined : providerLabel(props.agent.provider)));
</script>

<template>
    <button
        type="button"
        class="ui-row-select flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left max-md:min-h-10"
        :class="{ 'ui-row-select-on': selected, 'outline-2 outline-offset-1 outline-primary-500/60': idMatch?.exact === true }"
        @click="emit(`open`, $event)"
        @dblclick="emit(`review`)"
        @contextmenu.prevent.stop="emit(`menu`, $event)"
    >
        <Icon
            :name="glyph.icon"
            :spin="glyph.spin"
            role="img"
            :aria-label="glyph.label"
            v-tooltip.top="glyph.label"
            class="shrink-0 text-xs"
            :class="glyph.class"
        />
        <!-- Keeps a few characters of itself however much the row carries after it: a row that is only an id and a clock says nothing. -->
        <span class="min-w-10 flex-1 truncate text-xs" :class="settled ? 'text-muted' : 'text-content'">
            <span v-for="(run, at) in titleRuns" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''">{{ run.text }}</span>
        </span>
        <span v-if="idRuns !== undefined" class="min-w-0 max-w-2/5 truncate font-mono text-2xs text-muted">
            <span v-for="(run, at) in idRuns" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''">{{ run.text }}</span>
        </span>
        <span v-if="elsewhere !== undefined" class="shrink-0 text-2xs text-subtle">{{ elsewhere }}</span>
        <span v-if="working && agent.startedAt !== undefined" v-tooltip.top="doing" class="shrink-0 text-2xs font-medium tabular-nums text-link">{{
            formatElapsed(agent.startedAt, now)
        }}</span>
        <span v-else-if="agent.updatedAt > 0" class="shrink-0 text-2xs text-subtle">{{ relativeTime(agent.updatedAt) }}</span>
    </button>
</template>
