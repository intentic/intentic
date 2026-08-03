<script setup lang="ts">
import { cmp, formatTime, formatTimestamp, Icon, type IconName, StatusBadge, timeAgo } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { type Episode, sourceLabel, typeLabel } from "./episodes";
import { host } from "./host";

/* One thing that happened, on one line — with everything the old view made you scroll past four rows to learn:
 * what it was called, who set it off, what served it, how long it took, what it cost, whether it failed.
 *
 * Collapsed is the answer; expanded is the evidence. The raw events the daemon appended are always one click
 * away, because a feed you cannot audit down to the actual record is not an audit surface. Opening the transcript
 * is the other exit — "why did it do that" is only ever answered by reading the turn. */

const { episode } = defineProps<{ episode: Episode }>();

const api = host();
const open = ref(false);

const KIND_ICONS: Readonly<Record<Episode["kind"], IconName>> = { turn: `sparkles`, message: `arrow-down-left`, event: `cog` };
const KIND_TINTS: Readonly<Record<Episode["kind"], string>> = { turn: `text-link`, message: `text-info`, event: `text-subtle` };

// Seconds under a minute, m/s above it — a turn is seconds to minutes, and "110318ms" is not a duration anyone reads.
const duration = computed(() => {
    if (episode.durationMs === undefined) {
        return undefined;
    }
    const seconds = Math.round(episode.durationMs / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
});
// Sub-cent turns round to $0.00, which reads as free rather than as small.
const cost = computed(() => (episode.costUsd === undefined ? undefined : episode.costUsd < 0.01 ? `<$0.01` : `$${episode.costUsd.toFixed(2)}`));
</script>

<template>
    <div class="py-1.5">
        <div class="flex items-start gap-2">
            <button
                type="button"
                class="mt-0.5 shrink-0 cursor-pointer text-2xs text-subtle hover:text-content"
                :aria-expanded="open"
                :aria-label="open ? `Collapse` : `Expand`"
                @click="open = !open"
            >
                <Icon :name="open ? `chevron-down` : `chevron-right`" />
            </button>
            <Icon :name="KIND_ICONS[episode.kind]" class="mt-0.5 shrink-0 text-xs" :class="KIND_TINTS[episode.kind]" />

            <div class="min-w-0 flex-1">
                <div class="flex items-baseline gap-2">
                    <!-- The headline. A turn with a transcript opens it; anything else is plain text, because a
                         dead link is worse than no affordance. -->
                    <button
                        v-if="episode.sessionId"
                        type="button"
                        class="min-w-0 flex-1 cursor-pointer truncate text-left text-sm font-medium text-content hover:text-link hover:underline"
                        :title="episode.label"
                        @click="api.chat.openSession(episode.sessionId)"
                    >
                        {{ episode.label }}
                    </button>
                    <span v-else class="min-w-0 flex-1 truncate text-sm font-medium text-content" :title="episode.label">{{ episode.label }}</span>
                    <span class="shrink-0 text-2xs text-subtle" :title="formatTimestamp(episode.at)">{{ timeAgo(episode.at) }}</span>
                </div>

                <!-- The facts line: who called, what served it, what it cost, what it did. Every part conditional —
                     an empty separator is noise, and most episodes carry only some of these. -->
                <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted">
                    <StatusBadge v-if="episode.failed" variant="danger" label="Failed" size="xs" dot />
                    <span v-if="episode.typeName">{{ episode.typeName }}</span>
                    <span v-if="episode.author">from {{ episode.author }}</span>
                    <span v-if="episode.channelId" class="font-mono text-subtle">#{{ episode.channelId }}</span>
                    <span v-if="episode.runtime">{{ sourceLabel(episode.runtime) }}</span>
                    <span v-if="duration">{{ duration }}</span>
                    <span v-if="cost">{{ cost }}</span>
                    <span v-if="episode.outbound > 0">{{ episode.outbound }} outbound {{ episode.outbound === 1 ? `call` : `calls` }}</span>
                    <span v-if="episode.automationIds?.length" class="font-mono text-subtle">{{ episode.automationIds.join(`, `) }}</span>
                </div>

                <p v-if="episode.error" class="mt-0.5 break-words text-2xs text-danger">{{ episode.error }}</p>
                <p v-if="!open && episode.detail && episode.detail !== episode.label" class="mt-0.5 line-clamp-1 text-2xs text-subtle">
                    {{ episode.detail }}
                </p>

                <!-- Expanded: the daemon's own rows, oldest first, exactly as written. -->
                <div v-if="open" class="mt-1.5 flex flex-col gap-1 border-l border-line pl-3">
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
                    <button
                        v-if="episode.sessionId"
                        type="button"
                        :class="cmp.linkButton('text-2xs')"
                        @click="api.chat.openSession(episode.sessionId)"
                    >
                        <Icon name="external-link" /> Open transcript
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
