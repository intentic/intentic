<!-- A SPAWNED CHILD THAT IS NOT AN AGENT YET, drawn in its parent's tray where its own row will arrive (childFold
     startingChild). The daemon files a child the moment its parent asks for it, but the fleet holds it only once its first
     turn begins, and a start can wait minutes before that: on the owner's answer, behind its lane's first child until a
     provider nothing had proven answers (fan-out-governor.ts), for a seat or for memory. Four children the owner had just
     allowed were nowhere on the board for a minute and a half, which read as a start that broke. Dashed, as every place
     something will go (LaunchCard, FirstAgentSlot), so it never passes for an agent you can open; a status, not a press,
     having no chat yet. ChildRow's own layout, so the row that replaces it lands where this one stood. -->
<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { SubagentSession } from "@intentic/sandbox-contract/schemas/terminal";
import { formatElapsed } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { markSegments } from "../../lib/markSegments";
import { subagentStatusMeta } from "../../models/agent-status/agentStatus-meta";
import { subagentTitle } from "../../models/fleet/board/childFold";
import { runLook } from "../../models/fleet/board/childLook";
import RunFacts from "./RunFacts.vue";

const props = defineProps<{
    child: SubagentSession;
    // The provider the card above it runs on, for a roster row that names none.
    provider: AgentProvider;
    needle: string;
    matchCase: boolean;
}>();

const t = useT();
const now = useNow(() => true);
const title = computed(() => subagentTitle(props.child) ?? t(`shared.subagent`));
const titleRuns = computed(() => markSegments(title.value, props.matchCase ? props.needle : props.needle.toLowerCase(), props.matchCase));
// Held (`pending`) is the roster's own clock and word; past every hold, the few seconds before its turn begins.
const held = computed(() => props.child.status === `pending`);
const glyph = computed(() => (held.value ? subagentStatusMeta(`pending`) : { icon: `spinner` as const, spin: true, label: t(`agents.childRows.starting`), class: `text-muted` }));
// What it waits on, in the sandbox's words, where the daemon said: the clock's hover, as a working row's says what it does.
const why = computed(() => {
    const said = props.child.summary?.trim();
    return said === undefined || said === `` ? t(`agents.childRows.startingTip`) : said;
});
const run = computed(() => runLook(props.child.provider ?? props.provider, props.child.model, props.child.effort, undefined));
</script>

<template>
    <div
        role="status"
        :aria-label="`${title}: ${glyph.label}`"
        aria-busy="true"
        class="@container flex min-h-7 w-full min-w-0 select-none items-center gap-2 rounded-md px-2 outline-1 -outline-offset-1 outline-dashed outline-line-strong max-md:min-h-10"
        data-starting-child
    >
        <Icon :name="glyph.icon" :spin="glyph.spin" role="img" :aria-label="glyph.label" class="shrink-0 text-xs" :class="glyph.class" />
        <span class="min-w-0 flex-1 truncate text-xs text-muted">
            <span v-for="(part, at) in titleRuns" :key="at" :class="part.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''">{{ part.text }}</span>
        </span>
        <span v-if="run !== undefined" class="flex shrink-0 items-center text-2xs text-subtle">
            <RunFacts :run="run" columns />
        </span>
        <span v-tooltip.top="{ title: glyph.label, note: why }" class="flex shrink-0 items-center gap-1.5 text-2xs text-subtle">
            <span>{{ glyph.label }}</span>
            <span class="min-w-12 text-right tabular-nums">{{ formatElapsed((now - child.startedAt) / 1000) }}</span>
        </span>
    </div>
</template>
