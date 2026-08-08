<!-- THE POST, set to be read. The one thing on this page that is not chrome: the words a reviewer is being
     asked to approve, plus whatever goes out attached to them.

     A MEASURE, BEFORE ANYTHING ELSE. The queue's rows are as wide as the window, and a paragraph run across
     them is ~110 characters a line — past roughly 75 the eye loses its place on the return sweep, which is
     what made this page "unreadable" rather than merely plain. The column here is capped in `ch`, so it holds
     at any window width and on any theme's font, and the post reads at the same rhythm the platform will show
     it at. Size and leading go with it: body text people actually read, not the 12px the row's own metadata
     uses.

     EXACTLY THE BYTES THAT WILL BE POSTED. No markdown rendering, deliberately — half of these platforms take
     markdown and half take it literally, so a page that rendered `**bold**` would be showing the reviewer
     something the connector may never send, and hiding the one class of mistake that is invisible in the
     rendered form (a stray `*`, a fence that never closed). What structure there is comes from splitting on
     blank lines (postText.ts) and spacing the paragraphs like paragraphs.

     LONG POSTS FOLD. A YouTube description is a screenful on its own; three of them push everything else in
     the queue below the fold, including the section that owes a decision. Past LONG_POST the body clamps with
     a fade and a toggle — the same shape <Code> uses for a long command, for the same reason: a hard cut reads
     as a rendering bug. -->
<script setup lang="ts">
import type { DraftSummary } from "@intentic-app/api-contract";
import { cmp } from "@intentic/ui";
import { computed, ref } from "vue";
import { attachmentPreview } from "../../composables/chat/attachmentPreviews";
import { LONG_POST, paragraphsOf, postsATitle } from "./postText";

const { draft, tone = `full` } = defineProps<{
    draft: DraftSummary;
    /** `full` where a decision is owed; `quiet` for the sections that are only being kept an eye on. */
    tone?: `full` | `quiet`;
}>();

const paragraphs = computed(() => paragraphsOf(draft.content));

// Only when the platform really publishes one — otherwise the field is the agent's note and the row's footer
// carries it (postText.ts). A headline drawn for a note is the thing that used to outweigh the post itself.
const title = computed(() => (postsATitle(draft.platform, draft.target) ? draft.title : undefined));

const foldable = computed(() => draft.content.length > LONG_POST);
const expanded = ref(false);

// The file name alone: a media chip has room for `chart.png`, not for `.intentic/drafts/media/chart.png`.
const fileName = (path: string): string => path.split(`/`).at(-1) ?? path;
</script>

<template>
    <div :class="tone === `full` ? `max-w-[64ch]` : `max-w-[80ch]`">
        <!-- Quiet sections show the opening of the post, not the post: the decision there is already made, so
             a couple of lines are enough to tell one row from another. Still legible text — this is the line
             that had faded to 11px of the page's faintest grey in the posted list. -->
        <template v-if="tone === `quiet`">
            <p v-if="title" class="truncate text-sm font-medium text-content">{{ title }}</p>
            <p class="line-clamp-2 whitespace-pre-wrap wrap-break-word text-xs leading-relaxed text-muted" :class="title ? `mt-0.5` : ``">
                {{ draft.content }}
            </p>
        </template>

        <template v-else>
            <p v-if="title" class="wrap-break-word text-base font-semibold leading-snug text-content">{{ title }}</p>
            <div class="relative" :class="[title ? `mt-2` : ``, foldable && !expanded ? `max-h-80 overflow-hidden` : ``]">
                <p
                    v-for="(paragraph, index) in paragraphs"
                    :key="index"
                    class="whitespace-pre-wrap wrap-break-word text-[0.9375rem] leading-[1.7] text-content"
                    :class="index > 0 ? `mt-3` : ``"
                >
                    {{ paragraph }}
                </p>
                <!-- The fade is what says "there is more": a hard cut mid-sentence reads as a rendering bug. -->
                <div
                    v-if="foldable && !expanded"
                    class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-card to-transparent"
                ></div>
            </div>
            <button
                v-if="foldable"
                type="button"
                :class="cmp.linkButton(`mt-1 gap-1 text-2xs text-muted hover:text-content`)"
                @click="expanded = !expanded"
            >
                {{ expanded ? `Show less` : `Show the whole post` }}
                <Icon :name="expanded ? `chevron-up` : `chevron-down`" />
            </button>

            <!-- What goes out WITH the words. An image attached by mistake cannot be caught by re-reading the
                 caption, so attachments are shown rather than counted. -->
            <div v-if="draft.media && draft.media.length > 0" class="mt-3 flex flex-wrap items-center gap-2">
                <template v-for="path in draft.media" :key="path">
                    <img
                        v-if="attachmentPreview(path)"
                        :src="attachmentPreview(path)"
                        :alt="fileName(path)"
                        class="h-20 w-20 rounded-md border border-line object-cover"
                        v-tooltip.top="path"
                    />
                    <span v-else class="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-2xs text-muted" v-tooltip.top="path">
                        <Icon name="paperclip" />{{ fileName(path) }}
                    </span>
                </template>
            </div>
        </template>
    </div>
</template>
