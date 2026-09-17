<script setup lang="ts">
import { ui, Icon, Notice, noticeOf, ScrollFrame, SkeletonRows, timeWindowWords, type TimeWindow } from "@intentic/extension-ui";
import { computed } from "vue";
import { byDay, type Episode, type Source } from "./episodes";
import EpisodeRow from "./EpisodeRow.vue";
import { t } from "./i18n.js";

/* The selected source's story, newest first. */

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
    <!-- NOT `grow`: this panel is sized by its own max-height in a page-scrolling hub section, not by the free space of a bounded pane it no longer sits in. -->
    <!-- The filter bar immediately above already names the source and time window. -->
    <ScrollFrame :scroll="false" :aria-label="t(`activityTimeline.activityFeed`)">
        <!-- A connection that should be up and isn't says so here, where the person who selected it is looking. -->
        <template v-if="source?.lastError || source?.gateway === `idle`" #strips>
            <Notice v-if="source?.lastError" :of="noticeOf(source.lastError)" class="mx-4 mt-3" />
            <p v-else class="mx-4 mt-3 text-2xs text-muted">{{ t(`activityTimeline.idleNoEnabledListener`, { label: source.label }) }}</p>
        </template>

        <!-- The ROWS own the horizontal padding now (it is their density tier's, not this frame's). -->
        <div class="pb-2">
            <!-- THE FEED'S OWN SHAPE WHILE IT IS FETCHED, rather than a blank box that fills in one jump: a day divider and a run of rows, at the row's real spacing. -->
            <div v-if="isLoading && episodes.length === 0" role="status" aria-busy="true" :aria-label="t(`activityTimeline.loadingActivity`)">
                <div class="sticky top-0 z-1 flex items-center justify-between bg-card px-4 py-2 shadow-none">
                    <span class="skeleton block h-2 w-16" />
                    <span class="skeleton block h-2 w-12" />
                </div>
                <!-- The outline is the ROW's own, at the tier the feed actually draws, rather than a second hand-built guess at this row's shape. -->
                <div class="flex flex-col divide-y divide-line-subtle/50">
                    <SkeletonRows :rows="6" density="compact" description />
                </div>
            </div>

            <!-- Day labels are sticky signposts, not dividers, and they stick to the PAGE now that the card has no scroller of its own. -->
            <div v-for="(day, dayIndex) in days" :key="day.label" :class="dayIndex > 0 ? `mt-2` : ``">
                <div class="sticky top-0 z-1 flex items-center justify-between bg-card px-4 py-2 shadow-none">
                    <span class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ day.label }}</span>
                    <span class="text-2xs tabular-nums text-subtle">
                        {{ day.episodes.length }} {{ day.episodes.length === 1 ? `entry` : `entries` }}
                    </span>
                </div>
                <div class="flex flex-col divide-y divide-line-subtle/50">
                    <EpisodeRow v-for="episode in day.episodes" :key="episode.key" :episode="episode" />
                </div>
            </div>

            <p v-if="episodes.length === 0 && !isLoading" :class="ui.emptyState('px-4 py-10')">
                {{ t(`activityTimeline.nothingEntriesAppearMessage`, { window: timeWindowWords(window) }) }}
            </p>

            <!-- A capped feed must identify itself as incomplete. -->
            <p v-if="truncated" class="flex items-center justify-center gap-1.5 px-4 py-3 text-2xs text-muted">
                <Icon name="info-circle" />
                {{ t(`activityTimeline.showingMostRecentEntries`) }}
            </p>
        </div>
    </ScrollFrame>
</template>
