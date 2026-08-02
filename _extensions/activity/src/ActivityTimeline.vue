<script setup lang="ts">
import { cmp, Icon } from "@intentic/extension-ui";
import { computed } from "vue";
import { byDay, type Episode, type Source, type Window } from "./episodes";
import EpisodeRow from "./EpisodeRow.vue";

/* The selected source's story, newest first. Sectioned by day rather than run as one undifferentiated column:
 * "when" is the second question after "who", and a divider answers it for a whole run of rows at the cost of one
 * line. Nothing here is virtualised — the rail and the window are what keep the list short, and a bounded list of
 * real rows beats an unbounded one with a scrollbar as its only affordance. */

const { episodes, source, window, truncated, isLoading } = defineProps<{
    episodes: readonly Episode[];
    // The rail's selection resolved to its live facts; absent when every source is shown.
    source: Source | undefined;
    window: Window;
    truncated: boolean;
    isLoading: boolean;
}>();

const days = computed(() => byDay(episodes, Date.now()));

const WINDOW_WORDS: Readonly<Record<Window, string>> = {
    "1h": `in the last hour`,
    "24h": `in the last 24 hours`,
    "7d": `in the last 7 days`,
    all: `on record`,
};
</script>

<template>
    <section class="flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-card">
        <header class="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
            <h3 :class="cmp.sectionLabel()">{{ source?.label ?? `All sources` }}</h3>
            <span class="text-2xs text-subtle">
                {{ episodes.length }} {{ episodes.length === 1 ? `entry` : `entries` }} {{ WINDOW_WORDS[window] }}
            </span>
        </header>

        <!-- A connection that should be up and isn't says so here, where the person who selected it is looking. -->
        <p v-if="source?.lastError" :class="cmp.alertDanger('mx-4 mt-3 px-3 py-2 text-2xs')">{{ source.lastError }}</p>
        <p v-else-if="source?.gateway === `idle`" class="mx-4 mt-3 text-2xs text-muted">
            Idle — no enabled listener automation for {{ source.label }} yet, so nothing is being listened for.
        </p>

        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-2">
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
                Nothing {{ WINDOW_WORDS[window] }}. Entries appear when a message wakes the agent, when it calls a connected provider, and on every
                turn it runs.
            </p>

            <!-- Never let a bound look like an answer: if the page cap stopped the fetch, the feed is a prefix and
                 has to admit it rather than imply the window was quiet. -->
            <p v-if="truncated" class="flex items-center justify-center gap-1.5 py-3 text-2xs text-muted">
                <Icon name="info-circle" />
                Showing the most recent entries only — this window holds more than the feed fetches at once.
            </p>
        </div>
    </section>
</template>
