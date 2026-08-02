<script setup lang="ts">
import { cmp, Icon, Panel, PanelHeader, type TimeWindow, timeWindowWords } from "@intentic/extension-ui";
import { computed } from "vue";
import { byDay, type Episode, type Source } from "./episodes";
import EpisodeRow from "./EpisodeRow.vue";

/* The selected source's story, newest first. Sectioned by day rather than run as one undifferentiated column:
 * "when" is the second question after "who", and a divider answers it for a whole run of rows at the cost of one
 * line. Nothing here is virtualised — the rail and the window are what keep the list short, and a bounded list of
 * real rows beats an unbounded one with a scrollbar as its only affordance. */

const { episodes, source, window, truncated, isLoading } = defineProps<{
    episodes: readonly Episode[];
    // The rail's selection resolved to its live facts; absent when every source is shown.
    source: Source | undefined;
    window: TimeWindow;
    truncated: boolean;
    isLoading: boolean;
}>();

const days = computed(() => byDay(episodes, Date.now()));
</script>

<template>
    <Panel grow>
        <template #header>
            <PanelHeader>
                <template #title
                    ><span :class="cmp.sectionLabel()">{{ source?.label ?? `All sources` }}</span></template
                >
                <template #actions>
                    <span class="text-2xs text-subtle">
                        {{ episodes.length }} {{ episodes.length === 1 ? `entry` : `entries` }} {{ timeWindowWords(window) }}
                    </span>
                </template>
            </PanelHeader>
        </template>

        <!-- A connection that should be up and isn't says so here, where the person who selected it is looking.
             Above the scroll, so it stays put while the feed under it moves. -->
        <template v-if="source?.lastError || source?.gateway === `idle`" #strips>
            <p v-if="source?.lastError" :class="cmp.alertDanger('mx-4 mt-3 px-3 py-2 text-2xs')">{{ source.lastError }}</p>
            <p v-else class="mx-4 mt-3 text-2xs text-muted">
                Idle — no enabled listener automation for {{ source.label }} yet, so nothing is being listened for.
            </p>
        </template>

        <div class="px-4 py-2">
            <div v-for="day in days" :key="day.label" class="mb-1">
                <div class="sticky top-0 z-1 flex items-center gap-2 bg-card py-1">
                    <span class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ day.label }}</span>
                    <span class="h-px flex-1 bg-line"></span>
                </div>
                <div class="flex flex-col divide-y divide-line/60">
                    <EpisodeRow v-for="episode in day.episodes" :key="episode.key" :episode="episode" />
                </div>
            </div>

            <p v-if="episodes.length === 0 && !isLoading" :class="cmp.emptyState('py-10')">
                Nothing {{ timeWindowWords(window) }}. Entries appear when a message wakes the agent, when it calls a connected provider, and on every
                turn it runs.
            </p>

            <!-- Never let a bound look like an answer: if the page cap stopped the fetch, the feed is a prefix and
                 has to admit it rather than imply the window was quiet. -->
            <p v-if="truncated" class="flex items-center justify-center gap-1.5 py-3 text-2xs text-muted">
                <Icon name="info-circle" />
                Showing the most recent entries only — this window holds more than the feed fetches at once.
            </p>
        </div>
    </Panel>
</template>
