<script setup lang="ts">
import { ui, Icon, Notice, noticeOf, ScrollFrame, timeWindowWords, type TimeWindow } from "@intentic/extension-ui";
import { computed } from "vue";
import { byDay, type Episode, type Source } from "./episodes";
import EpisodeRow from "./EpisodeRow.vue";

/* The selected source's story, newest first. Sectioned by day rather than run as one undifferentiated column:
 * "when" is the second question after "who", and a sticky signpost answers it for a whole run of rows. Nothing
 * here is virtualised: the rail and the window are what keep the list short, and a bounded list of real rows
 * beats an unbounded one with a scrollbar as its only affordance. */

const { episodes, source, window, truncated, isLoading } = defineProps<{
    episodes: readonly Episode[];
    // The rail's selection resolved to its live facts; absent when every source is shown.
    source: Source | undefined;
    window: TimeWindow;
    truncated: boolean;
    isLoading: boolean;
}>();

const days = computed(() => byDay(episodes, Date.now()));

// Walked in order for the loading outline: real headlines are uneven, and six bars of one width read as a
// pattern rather than as a list.
const ROW_WIDTHS = [`w-64`, `w-48`, `w-56`, `w-40`, `w-52`, `w-44`];
</script>

<template>
    <!-- NOT `grow`: this panel is sized by its own max-height in a page-scrolling hub section, not by the free
         space of a bounded pane it no longer sits in. `flex-1` in an auto-height parent resolves to nothing. -->
    <!-- The filter bar immediately above already names the source and time window. Repeating both in a framed
         header added another horizontal band without adding information; the day headers carry the useful
         result counts instead. -->
    <ScrollFrame aria-label="Activity feed">
        <!-- A connection that should be up and isn't says so here, where the person who selected it is looking.
             Above the scroll, so it stays put while the feed under it moves. -->
        <template v-if="source?.lastError || source?.gateway === `idle`" #strips>
            <Notice v-if="source?.lastError" :of="noticeOf(source.lastError)" class="mx-4 mt-3" />
            <p v-else class="mx-4 mt-3 text-2xs text-muted">
                Idle: no enabled listener automation for {{ source.label }} yet, so nothing is being listened for.
            </p>
        </template>

        <div class="px-4 pb-2">
            <!-- THE FEED'S OWN SHAPE WHILE IT IS FETCHED, rather than a blank box that fills in one jump: a day
                 divider and a run of rows, at the row's real spacing, so the panel is the height it is going to
                 be. Only on the FIRST load: a poll or a widened window refetches with rows already on screen,
                 and replacing them with an outline would be the flicker this exists to remove. -->
            <div v-if="isLoading && episodes.length === 0" role="status" aria-busy="true" aria-label="Loading activity">
                <div class="sticky top-0 z-1 -mx-4 flex items-center justify-between bg-card px-4 py-2 shadow-none">
                    <span class="skeleton block h-2 w-16" />
                    <span class="skeleton block h-2 w-12" />
                </div>
                <div class="flex flex-col divide-y divide-line-subtle/50">
                    <div v-for="row in 6" :key="row" class="flex items-start gap-2 py-1.5" aria-hidden="true">
                        <span class="skeleton mt-0.5 block h-3 w-3 shrink-0" />
                        <span class="skeleton mt-0.5 block h-3 w-3 shrink-0" />
                        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                            <span class="flex min-h-lh items-center">
                                <span class="skeleton block h-3" :class="ROW_WIDTHS[(row - 1) % ROW_WIDTHS.length]" />
                            </span>
                            <span class="skeleton block h-2 w-32" />
                        </div>
                        <span class="skeleton mt-0.5 block h-2.5 w-10 shrink-0" />
                    </div>
                </div>
            </div>

            <!-- Day labels are sticky signposts, not dividers. `shadow-none` matters in the Sanctum skin: its
                 general `bg-card` treatment adds a bevel to card-painted surfaces, which otherwise turns every
                 sticky label into two unrequested horizontal rules. -->
            <div v-for="(day, dayIndex) in days" :key="day.label" :class="dayIndex > 0 ? `mt-2` : ``">
                <div class="sticky top-0 z-1 -mx-4 flex items-center justify-between bg-card px-4 py-2 shadow-none">
                    <span class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ day.label }}</span>
                    <span class="text-2xs tabular-nums text-subtle">
                        {{ day.episodes.length }} {{ day.episodes.length === 1 ? `entry` : `entries` }}
                    </span>
                </div>
                <div class="flex flex-col divide-y divide-line-subtle/50">
                    <EpisodeRow v-for="episode in day.episodes" :key="episode.key" :episode="episode" />
                </div>
            </div>

            <p v-if="episodes.length === 0 && !isLoading" :class="ui.emptyState('py-10')">
                Nothing {{ timeWindowWords(window) }}. Entries appear when a message wakes the agent, when it calls a connected provider, and on every
                turn it runs.
            </p>

            <!-- Never let a bound look like an answer: if the page cap stopped the fetch, the feed is a prefix and
                 has to admit it rather than imply the window was quiet. -->
            <p v-if="truncated" class="flex items-center justify-center gap-1.5 py-3 text-2xs text-muted">
                <Icon name="info-circle" />
                Showing the most recent entries only: this window holds more than the feed fetches at once.
            </p>
        </div>
    </ScrollFrame>
</template>
