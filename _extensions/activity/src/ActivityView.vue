<script setup lang="ts">
import { cmp, FilterBar, Icon, InfoHint, Segmented, sinceOf, StatusBadge, TIME_WINDOWS, type TimeWindow } from "@intentic/extension-ui";
import { computed } from "vue";
import ActivityTimeline from "./ActivityTimeline.vue";
import { matches, toEpisodes, toSources } from "./episodes";
import { host } from "./host";
import SourceFilter from "./SourceFilter.vue";
import { useActivity } from "./useActivity";

/* THE ACTIVITY SURFACE: what reached the agent, what it did about it, and how that went.
 *
 * ONE PANE, AND IT IS A SECTION OF THE SANDBOX HUB. This was a page of its own behind a rail tile, laid out as an
 * index of sources beside the feed. It is a hub section now (see extension.ts for why it left the rail), so the
 * page chrome — the title, the description, the index column — is the hub's, and what is left here is the
 * instrument and the feed. The three filters are unchanged and now sit in one row: WHO (the source picker), WHEN
 * (the window) and free text. The window is not cosmetic — it decides how far back the feed pages, so picking 7d
 * fetches until 7 days are actually covered.
 *
 * The timeline is WHAT HAPPENED, one row per thing that happened rather than one per row the daemon appended: a
 * turn's four lifecycle marks and every provider call it made are one entry (see episodes.ts, which owns all of
 * that and is where the tests are).
 *
 * Every filter lives in the URL, so a view of a bad hour on one connection is a link somebody can be sent.
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
    <!-- A HUB SECTION BODY — no page header and no frame of its own: the hub draws both, and a section that drew
         its own would sit as a page inside a page. -->
    <div class="flex flex-col gap-3">
        <div v-if="error" :class="cmp.alertDanger('px-4 py-3 text-sm')">{{ error }}</div>

        <!-- The daemon-held voice session, while one is live: sandbox-wide and transient, so it sits above the
             instrument rather than inside the feed it would otherwise scroll away with. -->
        <div v-if="status?.voice" class="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-card px-3 py-2">
            <Icon name="microphone" class="text-info" />
            <span class="text-sm font-medium text-content">#{{ status.voice.channelName }}</span>
            <StatusBadge variant="info" label="Transcribing" size="xs" dot />
            <span class="text-xs text-muted">
                {{ voiceMinutes }} min — {{ status.voice.participants.length > 0 ? status.voice.participants.join(`, `) : `no speakers yet` }}
            </span>
        </div>

        <!-- THE FILTER SITS ON THE THING IT FILTERS, and all three of them narrow the FEED — so all three are in
             its instrument, in the order a question is asked of a log: who, when, and what did it say. The source
             picker was a column beside the feed until this view became a hub section; the hub's own index column
             is where a second one would have gone (see SourceFilter). -->
        <FilterBar v-model="search" placeholder="Filter by text, channel, session…" :count="visible.length">
            <template #controls>
                <SourceFilter v-model="source" :sources="sources" :total="windowed.length" :failed="failed" />
                <span class="h-4 w-px bg-line" aria-hidden="true"></span>
                <Segmented v-model="window" size="xs" :options="TIME_WINDOWS" />
            </template>
            <template #actions>
                <InfoHint label="Activity">
                    <span class="block text-sm font-medium text-content">Activity</span>
                    <span class="mt-1 block text-xs text-muted">
                        One entry per thing that happened, grouped by <b>who set it off</b>: a connected provider that woke the agent, a schedule, or
                        you. A turn's whole lifecycle — start, plan, failure, completion, and every provider call it made — is one entry; expand it for
                        the raw events the daemon recorded.
                    </span>
                </InfoHint>
            </template>
        </FilterBar>

        <!-- Bounded, so the feed scrolls ITSELF instead of growing until the hub page scrolls it: the hub is a
             page-scrolling surface (its sections are usually forms), and a log that pushes the section index off
             screen is a log you have to scroll back up out of. Same idiom, and the same viewport units, as the
             log viewer one section over. -->
        <ActivityTimeline
            class="max-h-[60dvh]"
            :episodes="visible"
            :source="selected"
            :window="window"
            :truncated="truncated"
            :is-loading="isLoading"
        />
    </div>
</template>
