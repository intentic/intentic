<script setup lang="ts">
import {
    ui,
    FilterBar,
    InfoHint,
    Notice,
    noticeOf,
    Row,
    SegmentedControl,
    sinceOf,
    StatusBadge,
    TIME_WINDOWS,
    type TimeWindow,
} from "@intentic/extension-ui";
import { computed } from "vue";
import ActivityTimeline from "./ActivityTimeline.vue";
import { matches, toEpisodes, toSources } from "./episodes";
import { host } from "./host";
import SourceFilter from "./SourceFilter.vue";
import { useActivity } from "./useActivity";

// Activity surface: what reached the agent, what it did, and how that went. A hub section, not its own page: the hub
// draws page chrome, this owns the instrument and feed. Filters (source, window, text) live in the URL; read-only,
// since the log is daemon-written.

const api = host();

// Derived from the route query, not mirrored into refs, so Back/Forward keep working.
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

// Sources are tallied on the windowed set, so the rail's counts always match what the timeline shows.
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
    <!-- No page header or own frame here: the hub draws both around this section. -->
    <div class="flex flex-col gap-3">
        <Notice v-if="error" :of="noticeOf(error)" />

        <!-- Sits above the feed so it doesn't scroll away with it; `flush` is set since the bordered box outside already owns the padding. -->
        <div v-if="status?.voice" class="rounded-lg border border-line bg-card px-3 py-2">
            <Row icon="microphone" tone="info" density="compact" :flush="true" :title="`#${status.voice.channelName}`">
                <template #description>
                    {{ voiceMinutes }} min: {{ status.voice.participants.length > 0 ? status.voice.participants.join(`, `) : `no speakers yet` }}
                </template>
                <template #control><StatusBadge variant="info" label="transcribing" size="xs" dot /></template>
            </Row>
        </div>

        <!-- All three filters narrow the feed, so all three live in the instrument, ordered who, when, what. -->
        <FilterBar v-model="search" placeholder="Filter by text, channel, session…" :count="visible.length" :busy="isLoading">
            <template #controls>
                <SourceFilter v-model="source" :sources="sources" :total="windowed.length" :failed="failed" />
                <span class="h-4 w-px bg-line" aria-hidden="true"></span>
                <SegmentedControl v-model="window" size="xs" :options="TIME_WINDOWS" />
            </template>
            <template #actions>
                <InfoHint label="Activity">
                    <span class="block text-sm font-medium text-content">Activity</span>
                    <span class="mt-1 block text-xs text-muted">
                        One entry per thing that happened, grouped by <b>who set it off</b>: a connected provider that woke the agent, a schedule, or
                        you. A turn's whole lifecycle: start, plan, failure, completion, and every provider call it made, is one entry; expand it for
                        the raw events the daemon recorded.
                    </span>
                </InfoHint>
            </template>
        </FilterBar>

        <!-- Unbounded height: the feed scrolls with the page, since the section index is sticky and stays reachable without an inner scroller. -->
        <ActivityTimeline :episodes="visible" :source="selected" :window="window" :truncated="truncated" :is-loading="isLoading" />
    </div>
</template>
