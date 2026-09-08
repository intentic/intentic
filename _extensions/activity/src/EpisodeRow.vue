<script setup lang="ts">
import { ui, DisclosureRow, formatTime, formatTimestamp, Icon, type IconName, StatusBadge, timeAgo } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { type Episode, sourceLabel, typeLabel } from "./episodes";
import { host } from "./host";

// One thing that happened, one line collapsed; expanded shows the daemon's raw events and the transcript link. A
// `<DisclosureRow>`: lead glyph, title, description, trailing `#meta` facts, and the expanded block are its slots.
// `#meta` is how it ran; the description line is what it was.

const { episode } = defineProps<{ episode: Episode }>();

const api = host();
const open = ref(false);

const KIND_ICONS: Readonly<Record<Episode["kind"], IconName>> = { turn: `sparkles`, message: `arrow-down-left`, event: `cog` };
const KIND_TINTS: Readonly<Record<Episode["kind"], string>> = { turn: `text-link`, message: `text-info`, event: `text-subtle` };

// Renders as seconds under a minute, `m s` above it; raw milliseconds are unreadable.
const duration = computed(() => {
    if (episode.durationMs === undefined) {
        return undefined;
    }
    const seconds = Math.round(episode.durationMs / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
});
// Without this, a sub-cent cost would round to $0.00 and read as free.
const cost = computed(() => (episode.costUsd === undefined ? undefined : episode.costUsd < 0.01 ? `<$0.01` : `$${episode.costUsd.toFixed(2)}`));

// Preview only when the headline didn't come from this same content: an untitled turn's headline already is its detail,
// so showing it again would repeat one sentence twice.
const preview = computed(() => (episode.titled === true ? episode.detail : undefined));

// This row's identity, in reading order, omitting anything absent.
const facts = computed(() =>
    [
        episode.typeName,
        episode.author === undefined ? undefined : `from ${episode.author}`,
        episode.channelId === undefined ? undefined : `#${episode.channelId}`,
        episode.runtime === undefined ? undefined : sourceLabel(episode.runtime),
        episode.outbound > 0 ? `${episode.outbound} outbound ${episode.outbound === 1 ? `call` : `calls`}` : undefined,
    ].filter((fact): fact is string => fact !== undefined),
);
</script>

<template>
    <!--
        `hit="pair"`: keyboard focus lands on the chevron and glyph, not the headline, since the headline already opens the transcript (a button
        can't nest in a button). The whole row still opens on click; only the transcript link is excepted.
    -->
    <DisclosureRow v-model:open="open" density="compact" hit="pair">
        <template #lead>
            <Icon :name="KIND_ICONS[episode.kind]" class="text-xs" :class="open ? `` : KIND_TINTS[episode.kind]" />
        </template>

        <!--
            Only wraps in a button when there's a transcript to open, since a dead link affordance is worse than none. `w-fit` keeps the link's hit
            area (and underline) to its text, not the full row width, since the row itself opens on click too.
        -->
        <template #title>
            <button
                v-if="episode.sessionId"
                type="button"
                class="block w-fit max-w-full cursor-pointer truncate text-left hover:text-link hover:underline"
                :title="episode.label"
                @click="api.chat.openSession(episode.sessionId)"
            >
                {{ episode.label }}
            </button>
            <span v-else class="block min-w-0 truncate" :title="episode.label">{{ episode.label }}</span>
        </template>

        <!--
            Facts and preview share one line (this slot renders as one paragraph), so a titled turn doesn't grow to three lines vs its neighbors'
            two. A failure keeps its own line below.
        -->
        <template v-if="facts.length > 0 || preview || episode.error" #description>
            <span class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span v-for="fact in facts" :key="fact">{{ fact }}</span>
                <!--
                    `flex-1` needs a zero basis, not just `min-w-0`: from its full content width the preview would wrap to its own line before
                    shrinking, pushing this row to three lines on a narrow pane.
                -->
                <span v-if="!open && preview" class="min-w-0 flex-1 truncate text-subtle">{{ preview }}</span>
            </span>
            <span v-if="episode.error" class="mt-0.5 block break-words text-danger">{{ episode.error }}</span>
        </template>

        <!-- How it ran: trailing and tabular, so times and costs line up down the list. -->
        <template #meta>
            <StatusBadge v-if="episode.failed" variant="danger" label="failed" size="xs" dot />
            <span v-if="duration">{{ duration }}</span>
            <span v-if="cost">{{ cost }}</span>
            <span :title="formatTimestamp(episode.at)">{{ timeAgo(episode.at) }}</span>
        </template>

        <!--
            The daemon's own rows, oldest first, unedited. Inset behind a rail rather than a hairline, since a hairline already separates episodes in
            this list; `<DisclosureRow>` owns the rail and its alignment under the headline.
        -->
        <template #below>
            <div class="flex flex-col gap-1">
                <p v-if="episode.detail" class="whitespace-pre-wrap break-words text-2xs text-muted">{{ episode.detail }}</p>
                <div v-for="entry in episode.events" :key="entry.id" class="flex flex-wrap items-baseline gap-x-2 text-2xs">
                    <span class="font-mono text-subtle">{{ formatTime(entry.at) }}</span>
                    <span class="text-muted">{{ typeLabel(entry.type) }}</span>
                    <span v-if="entry.method" class="font-mono text-subtle">{{ entry.method }} {{ entry.endpoint }}</span>
                    <span v-if="entry.outcome === `error`" class="text-danger">{{ entry.error ?? `error` }}</span>
                </div>
                <div class="flex flex-wrap items-center gap-x-3 font-mono text-2xs text-subtle/70">
                    <span v-if="episode.sessionId">session {{ episode.sessionId }}</span>
                    <span>source {{ sourceLabel(episode.sourceKey) }}</span>
                </div>
                <button v-if="episode.sessionId" type="button" :class="ui.linkButton('gap-1 text-2xs')" @click="api.chat.openSession(episode.sessionId)">
                    <Icon name="external-link" class="shrink-0" /> Open transcript
                </button>
            </div>
        </template>
    </DisclosureRow>
</template>
