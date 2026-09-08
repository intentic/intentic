<!--
    Renders the post text under review via the shared <Markdown> component, so approvals see the same formatting the platform will. Column width is
    capped in `ch` to keep lines readable. Posts longer than LONG_POST clamp with a fade and a toggle.
-->
<script setup lang="ts">
import type { PostApprovalSummary } from "@intentic/sandbox-contract";
import { ui, Markdown } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { attachmentPreview } from "./attachmentPreviews";
import { LONG_POST, postsATitle } from "./postText";

const { post, tone = `full` } = defineProps<{
    post: PostApprovalSummary;
    /** `full` where a decision is owed; `quiet` for the sections that are only being kept an eye on. */
    tone?: `full` | `quiet`;
}>();

// Only when the platform really publishes one: otherwise the field is the agent's note and the row's footer
// carries it (postText.ts). A headline drawn for a note is the thing that used to outweigh the post itself.
const title = computed(() => (postsATitle(post.platform, post.target) ? post.title : undefined));

const foldable = computed(() => post.content.length > LONG_POST);
const expanded = ref(false);

// The file name alone: a media chip has room for `chart.png`, not for `.intentic/config/approvals/media/chart.png`.
const fileName = (path: string): string => path.split(`/`).at(-1) ?? path;
</script>

<template>
    <div :class="tone === `full` ? `max-w-read` : `max-w-read-lg`">
        <!-- Quiet sections show the opening of the post, not the post: the decision there is already made, so
             a couple of lines are enough to tell one row from another. Still legible text: this is the line
             that had faded to 11px of the page's faintest grey in the done list. -->
        <template v-if="tone === `quiet`">
            <p v-if="title" class="truncate text-sm font-medium text-content">{{ title }}</p>
            <div class="max-h-10 overflow-hidden" :class="title ? `mt-0.5` : ``">
                <Markdown
                    :source="post.content"
                    style="--prose-size: 0.75rem; --prose-code: 0.6875rem; --prose-lead: 1.625; --prose-gap: 0.35em; color: var(--color-muted)"
                />
            </div>
        </template>

        <template v-else>
            <p v-if="title" class="wrap-break-word text-base font-semibold leading-snug text-content">{{ title }}</p>
            <div class="relative" :class="[title ? `mt-2` : ``, foldable && !expanded ? `max-h-80 overflow-hidden` : ``]">
                <Markdown :source="post.content" style="--prose-measure: 72ch" />
                <!-- The fade is what says "there is more": a hard cut mid-sentence reads as a rendering bug. -->
                <div
                    v-if="foldable && !expanded"
                    class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-card to-transparent"
                ></div>
            </div>
            <button
                v-if="foldable"
                type="button"
                :class="ui.linkButton(`mt-1 gap-1 text-2xs text-muted hover:text-content`)"
                @click="expanded = !expanded"
            >
                {{ expanded ? `Show less` : `Show the whole post` }}
                <Icon :name="expanded ? `chevron-up` : `chevron-down`" />
            </button>

            <!-- What goes out WITH the words. An image attached by mistake cannot be caught by re-reading the
                 caption, so attachments are shown rather than counted. -->
            <div v-if="post.media && post.media.length > 0" class="mt-3 flex flex-wrap items-center gap-2">
                <template v-for="path in post.media" :key="path">
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
