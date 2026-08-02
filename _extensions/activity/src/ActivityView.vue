<script setup lang="ts">
import { cmp, FilterBar, Icon, InfoHint, PageHeader, Segmented, sinceOf, StatusBadge, TIME_WINDOWS, type TimeWindow } from "@intentic/extension-ui";
import { computed } from "vue";
import ActivityTimeline from "./ActivityTimeline.vue";
import { matches, toEpisodes, toSources } from "./episodes";
import { host } from "./host";
import SourceRail from "./SourceRail.vue";
import { useActivity } from "./useActivity";

/* THE ACTIVITY SURFACE: what reached the agent, what it did about it, and how that went.
 *
 * Two panes. The rail is WHO — connections and you, bounded by how many things can call rather than by how often
 * they do. The timeline is WHAT HAPPENED, one row per thing that happened rather than one per row the daemon
 * appended: a turn's four lifecycle marks and every provider call it made are one entry (see episodes.ts, which
 * owns all of that and is where the tests are).
 *
 * Three filters over that, and no more: WHO (the rail), WHEN (the window), and free text. The window is not
 * cosmetic — it decides how far back the feed pages, so picking 7d fetches until 7 days are actually covered.
 *
 * Every one of those lives in the URL, so a view of a bad hour on one connection is a link somebody can be sent.
 * Read-only throughout: the log is daemon-written, outside the agent's own reach. */

const api = host();

// Derived from the query rather than mirrored into refs — one direction of flow, and Back/Forward work for free.
const query = computed(() => api.route.query());
const window = computed<TimeWindow>({
    get: () => {
        const value = query.value[`window`];
        return value === `1h` || value === `7d` || value === `all` ? value : `24h`;
    },
    set: (value) => api.route.setQuery({ window: value === `24h` ? undefined : value }),
});
const source = computed<string | undefined>({
    get: () => query.value[`source`],
    set: (value) => api.route.setQuery({ source: value }),
});
const search = computed<string>({
    get: () => query.value[`q`] ?? ``,
    set: (value) => api.route.setQuery({ q: value === `` ? undefined : value }),
});

const { events, status, error, isLoading, truncated } = useActivity(window);

// The window bounds the feed; the rail and the search bound it further. Sources are tallied on the WINDOWED set,
// so a rail count always agrees with the timeline it opens.
const windowed = computed(() => {
    const since = sinceOf(window.value, Date.now());
    return toEpisodes(events.value).filter((episode) => episode.at >= since);
});
const sources = computed(() => toSources(windowed.value, status.value?.connections ?? []));
const selected = computed(() => sources.value.find((entry) => entry.key === source.value));
const visible = computed(() =>
    windowed.value.filter((episode) => (source.value === undefined || episode.sourceKey === source.value) && matches(episode, search.value)),
);
const failed = computed(() => windowed.value.filter((episode) => episode.failed).length);

const voiceMinutes = computed(() => (status.value?.voice === undefined ? 0 : Math.round((Date.now() - status.value.voice.startedAt) / 60_000)));
</script>

<template>
    <!-- FILLS THE AREA AND OWNS ITS SCROLLING. The shell's router-view wrapper is itself a scroll container, so a
         view that merely grows makes the header and both panes scroll together as one tall column — which is the
         failure this view had. `h-full` + `overflow-hidden` leaves the outer scroller nothing to scroll, and the
         rail and the timeline each take their own. Same shape as the documentation extension's browser. -->
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
        <!-- The head does not scroll: the title and the three filters stay put while you read the timeline. -->
        <div class="shrink-0 px-6 pt-6">
            <PageHeader title="Activity" description="What reached the agent, what it did about it, and how that went.">
                <template #info>
                    <InfoHint label="Activity">
                        <span class="block text-sm font-medium text-content">Activity</span>
                        <span class="mt-1 block text-xs text-muted">
                            One entry per thing that happened, grouped by <b>who set it off</b>: a connected provider that woke the agent, a schedule,
                            or you. A turn's whole lifecycle — start, plan, failure, completion, and every provider call it made — is one entry;
                            expand it for the raw events the daemon recorded.
                        </span>
                    </InfoHint>
                </template>
            </PageHeader>
        </div>

        <div class="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-6">
            <div v-if="error" :class="cmp.alertDanger('px-4 py-3 text-sm')">{{ error }}</div>

            <!-- The daemon-held voice session, while one is live: sandbox-wide and transient, so it sits above both
                 panes rather than inside whichever one happens to be selected. -->
            <div v-if="status?.voice" class="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-card px-3 py-2">
                <Icon name="microphone" class="text-info" />
                <span class="text-sm font-medium text-content">#{{ status.voice.channelName }}</span>
                <StatusBadge variant="info" label="Transcribing" size="xs" dot />
                <span class="text-xs text-muted">
                    {{ voiceMinutes }} min — {{ status.voice.participants.length > 0 ? status.voice.participants.join(`, `) : `no speakers yet` }}
                </span>
            </div>

            <FilterBar v-model="search" placeholder="Filter by text, channel, session…" :count="visible.length">
                <template #controls><Segmented v-model="window" size="xs" :options="TIME_WINDOWS" /></template>
            </FilterBar>

            <div class="flex min-h-0 flex-1 flex-col gap-3 md:flex-row md:gap-4">
                <SourceRail v-model="source" :sources="sources" :total="windowed.length" :failed="failed" />
                <ActivityTimeline :episodes="visible" :source="selected" :window="window" :truncated="truncated" :is-loading="isLoading" />
            </div>
        </div>
    </div>
</template>
