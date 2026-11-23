<!-- Why an agent card matched the board's filter; leads the card's body while a filter is active (AgentCard). An id is
     its own evidence, since nothing the card says holds it: spelled as typed, in the id's own face, and named whole when
     it is. Any other hit is the line it was found in, its speaker named (MatchLine). -->
<script setup lang="ts">
import type { MatchSnippet } from "@intentic/sandbox-contract/schemas/agent-search";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import MatchLine from "../../../../../components/MatchLine.vue";
import { markSegments } from "../../../../../lib/markSegments";
import { formatChord, isApplePlatform } from "../../../../../workbench/commands/keybindings";
import type { IdMatch } from "../../idMatch";

const props = defineProps<{
    idMatch: IdMatch | undefined;
    match: MatchSnippet | undefined;
    needle: string;
    matchCase: boolean;
    // A dense card's body is one wrapping line, where the evidence takes a line of its own.
    dense?: boolean;
}>();

const t = useT();
// The filter's own key for opening the card its id names, drawn as the key cap the tip wears.
const enterKey = formatChord(`enter`, isApplePlatform());
// The identifier the filter matched, its matched part marked; ids have no case, so neither does the mark.
const idRuns = computed(() => (props.idMatch === undefined ? [] : markSegments(props.idMatch.text, props.idMatch.mark)));
</script>

<template>
    <p v-if="idMatch !== undefined" class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted" :class="dense ? 'w-full' : ''">
        <Icon name="search" class="shrink-0 text-2xs text-subtle" />
        <span class="min-w-0 truncate font-mono">
            <span v-for="(run, at) in idRuns" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''">{{ run.text }}</span>
        </span>
        <span
            v-if="idMatch.exact"
            v-tooltip.top="{ title: t(`ui.action.open`), keys: enterKey }"
            class="ui-status-pill ui-status-pill-inline shrink-0 bg-primary-600/20 font-semibold text-link"
            >{{ t(`agents.agentCard.exactId`) }}</span
        >
    </p>
    <p v-else-if="match !== undefined" class="flex min-w-0 items-start gap-2 text-2xs text-muted" :class="dense ? 'w-full' : ''">
        <Icon name="search" class="shrink-0 text-2xs text-subtle" />
        <MatchLine :snippet="match" :needle="needle" :match-case="matchCase" class="line-clamp-2 min-w-0 flex-1 leading-4" />
    </p>
</template>
