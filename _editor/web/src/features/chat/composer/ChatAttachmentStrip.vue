<script setup lang="ts">
import { attachmentPeek } from "../drafts/attachmentPeeks";
import { attachmentAudio, attachmentKind } from "../drafts/attachmentPreviews";
import ChatAudioChip from "../transcript/ChatAudioChip.vue";
import ChatFileChip from "../transcript/ChatFileChip.vue";
import ChatImageThumb from "../transcript/ChatImageThumb.vue";

/* What a sent prompt's attachments look like: a hover-previewable thumbnail per image, a player per sound, a bare tile with the file's own first lines for everything else. */

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
            <ChatAudioChip
                v-else-if="attachmentKind(attachment.path) === `audio`"
                :name="attachment.name"
                :path="attachment.path"
                :src="attachmentAudio(attachment.path)"
            />
            <ChatFileChip v-else :name="attachment.name" :path="attachment.path" :peek="attachmentPeek(attachment.path)" :lead="LEAD_LINES" />
        </template>
    </div>
</template>
