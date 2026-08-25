<script setup lang="ts">
import { ui, DisclosureRow, formatTime, formatTimestamp, Icon, type IconName, StatusBadge, timeAgo } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { type Episode, sourceLabel, typeLabel } from "./episodes";
import { host } from "./host";

/* One thing that happened, on one line: with everything the old view made you scroll past four rows to learn:
 * what it was called, who set it off, what served it, how long it took, what it cost, whether it failed.
 *
 * Collapsed is the answer; expanded is the evidence. The raw events the daemon appended are always one click
 * away, because a feed you cannot audit down to the actual record is not an audit surface. Opening the transcript
 * is the other exit: "why did it do that" is only ever answered by reading the turn.
 *
 * THIS IS A <DisclosureRow>, AND IT USED TO BE A <Row> WITH A HAND-BUILT DISCLOSURE ON IT, which is what the
 * row's anatomy is now spelled in rather than re-derived: the lead glyph, the title, the description under it,
 * the trailing FACTS cluster and the expanded block are that component's five slots, and the chevron, the
 * ARIA, the open tint and the rail beneath are its own. Hand-written, this file had picked `py-1.5` for its own density tier,
 * `text-2xs text-muted` for facts the kit sets at `text-2xs text-subtle`, and `mt-0.5` on both lead glyphs:
 * the three drifts <Row>'s own notes name as the reason record lists stopped using it. It also means the
 * loading outline is <SkeletonRows> for real now, rather than a second hand-built guess at this row's shape.
 *
 * WHAT GOES WHERE IS SPLIT BY QUESTION, not by length. `#meta` is HOW IT RAN: whether it failed, how long, what
 * it cost, how long ago, which is the cluster a reader scans DOWN a column of rows, so it is trailing and
 * tabular. The line under the title is WHAT IT WAS: the type, the caller, the channel, the runtime, read one
 * row at a time. They were one wrapping line of nine grey fragments before, in which "Claude", "4m 2s" and
 * "$2.81" were the same kind of thing. */

const { episode } = defineProps<{ episode: Episode }>();

const api = host();
const open = ref(false);

const KIND_ICONS: Readonly<Record<Episode["kind"], IconName>> = { turn: `sparkles`, message: `arrow-down-left`, event: `cog` };
const KIND_TINTS: Readonly<Record<Episode["kind"], string>> = { turn: `text-link`, message: `text-info`, event: `text-subtle` };

// Seconds under a minute, m/s above it: a turn is seconds to minutes, and "110318ms" is not a duration anyone reads.
const duration = computed(() => {
    if (episode.durationMs === undefined) {
        return undefined;
    }
    const seconds = Math.round(episode.durationMs / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
});
// Sub-cent turns round to $0.00, which reads as free rather than as small.
const cost = computed(() => (episode.costUsd === undefined ? undefined : episode.costUsd < 0.01 ? `<$0.01` : `$${episode.costUsd.toFixed(2)}`));

/* WHETHER THE PREVIEW SAYS ANYTHING THE HEADLINE DID NOT.
 *
 * An untitled turn and every loose event take their headline FROM their content (episodes.ts), so a preview of
 * that same content under it is the row printing one sentence twice: once clipped at 120 characters, once in
 * full. The old guard was `detail !== label`, which is exactly false in the one case it was written for and
 * true in every case that matters: a headline is a prefix of its detail, never equal to it, the moment the
 * content runs past a line or past the clip. `titled` is the honest question: the label came from somewhere
 * else (the conversation's own name), so the content is a second fact and worth a line. */
const preview = computed(() => (episode.titled === true ? episode.detail : undefined));

// The row's own identity, in reading order and only where there is something to say.
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
    <!-- `hit="pair"` — the KEYBOARD's way in is the chevron and the kind glyph, not the headline, because on a
         turn the headline already has a job of its own (it opens the transcript) and a button cannot nest in a
         button. It bounds the tab stop, not the press: the whole row still opens on a click, the transcript
         link excepted. -->
    <DisclosureRow v-model:open="open" density="compact" hit="pair">
        <template #lead>
            <Icon :name="KIND_ICONS[episode.kind]" class="text-xs" :class="open ? `` : KIND_TINTS[episode.kind]" />
        </template>

        <!-- A turn with a transcript opens it; anything else is plain text, because a dead link is worse than no
             affordance.

             `w-fit` IS THE WHOLE POINT OF THIS BLOCK, and it is what the two affordances on this line cost.
             The label was `block`, so the link's hit area ran the full width of the headline while its underline
             ran only under the words: press the empty space after a four-word turn title and the app LEFT FOR
             THE TRANSCRIPT, when the row it was in — and every row above and below it — opens on that same
             press. A link that hugs its text makes the rule legible without a word of explanation: underlined
             is where you go, everything else is where you open. `max-w-full` keeps `truncate` doing its job on
             a long one. -->
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

        <!-- WHAT IT WAS, ON ONE LINE WITH ITS PREVIEW. Spans rather than blocks: <Row> renders this slot inside
             its own paragraph.
             The two shared a column and did not need two lines of it: "Claude" and the prompt it ran are the
             same answer to "what was this", and stacking them made a titled turn three lines tall where every
             row around it was two, which is what left the trailing time cluster floating against nothing. A
             failure keeps its own line: it is the one thing here worth the width. -->
        <template v-if="facts.length > 0 || preview || episode.error" #description>
            <span class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span v-for="fact in facts" :key="fact">{{ fact }}</span>
                <!-- `flex-1` FROM A ZERO BASIS, not `min-w-0` alone: a wrapping line breaks on an item's base
                     size, so a preview measured at its full content width jumps to a line of its own before it
                     ever considers shrinking, and the row it was meant to keep at two lines becomes three on a
                     narrow pane. From a zero basis there is nothing to break for, and it truncates instead. -->
                <span v-if="!open && preview" class="min-w-0 flex-1 truncate text-subtle">{{ preview }}</span>
            </span>
            <span v-if="episode.error" class="mt-0.5 block break-words text-danger">{{ episode.error }}</span>
        </template>

        <!-- HOW IT RAN, trailing and tabular so times and costs line up down the list rather than each sitting
             wherever its row's own facts happened to end. -->
        <template #meta>
            <StatusBadge v-if="episode.failed" variant="danger" label="Failed" size="xs" dot />
            <span v-if="duration">{{ duration }}</span>
            <span v-if="cost">{{ cost }}</span>
            <span :title="formatTimestamp(episode.at)">{{ timeAgo(episode.at) }}</span>
        </template>

        <!-- THE EVIDENCE: the daemon's own rows, oldest first, exactly as written. Inset behind a rail rather
             than parted by a hairline, because the hairline between two EPISODES is the separator this list
             already spends, and a third tier drawn with the same stroke is the one nobody can place. The rail,
             and the offset that aligns it under the headline instead of the row's own edge, are
             <DisclosureRow>'s: this file wrote both by hand, and the hand-written offset (a hidden copy of the
             lead cluster) is the trick the component now performs for all fourteen lists. -->
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
