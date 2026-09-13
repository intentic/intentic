<script setup lang="ts">
import { attachmentPeek } from "../drafts/attachmentPeeks";
import ChatFileChip from "../transcript/ChatFileChip.vue";
import ChatImageThumb from "../transcript/ChatImageThumb.vue";

/* What a sent prompt's attachments look like: a hover-previewable thumbnail per image, a bare tile with the file's own
 * first lines for everything else. Neither wears the bubble's surface — what the user SAID is a bubble; what they
 * brought with it is an object sitting beside one. Only the arrangement belongs to the caller: ChatMessageView mounts
 * one copy as the row above the bubble and a second beside it, and lets a container query pick which of the two is
 * shown. Extracted so the two can't drift apart. */

defineProps<{ attachments: readonly { name: string; path: string; previewUrl?: string }[] }>();

// How many of a file's own lines the chip draws. Three: enough to tell one capture from another, short enough that a
// row of chips still reads as a row.
const LEAD_LINES = 3;
</script>

<template>
    <!-- `items-start`: a tile beside a thumbnail must keep its own height, not stretch to the picture's and read as an empty box. -->
    <!-- `gap-3`: with no box of their own, two attachments need the space between them to do the separating. -->
    <div class="flex items-start gap-3">
        <template v-for="attachment in attachments" :key="attachment.path">
            <ChatImageThumb v-if="attachment.previewUrl" :src="attachment.previewUrl" :alt="attachment.name" size="h-14 w-14" />
            <ChatFileChip
                v-else
                :name="attachment.name"
                :path="attachment.path"
                :peek="attachmentPeek(attachment.path)"
                :lead="LEAD_LINES"
            />
        </template>
    </div>
</template>
