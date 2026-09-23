<script
    setup
    lang="ts"
    generic="T extends Pick<PendingAttachment, 'name' | 'path' | 'previewUrl'> & Partial<Pick<PendingAttachment, 'status' | 'progress' | 'error'>>"
>
import { attachmentPeek } from "../drafts/attachmentPeeks";
import { attachmentAudio, attachmentKind, attachmentPreview } from "../drafts/attachmentPreviews";
import type { PendingAttachment } from "../drafts/useChatAttachments";
import ChatAudioChip from "../transcript/attachments/ChatAudioChip.vue";
import ChatFileChip from "../transcript/attachments/ChatFileChip.vue";
import ChatImageThumb from "../transcript/attachments/ChatImageThumb.vue";

/* A row of attachments, each drawn by what it is: a player per sound, a file chip per anything else, and on a sent prompt a bare hover-previewable thumbnail per picture. Staged (the composer's) chips are framed, removable and show their upload. */

const { staged = false } = defineProps<{ attachments: readonly T[]; staged?: boolean }>();
const emit = defineEmits<{ remove: [attachment: T] }>();

// How many of a file's own lines a sent chip draws: enough to tell one capture from another, short enough to keep a row.
const LEAD_LINES = 3;

// On disk, so read by path: a sent file, or a staged one whose upload finished; before that only its own bytes can be drawn.
const landed = (attachment: T): boolean => attachment.status === undefined || attachment.status === `done`;
const pictureOf = (attachment: T): string | undefined => (landed(attachment) ? attachmentPreview(attachment.path) : attachment.previewUrl);
const progressOf = (attachment: T): number | undefined => (attachment.status === `uploading` ? attachment.progress : undefined);
const errorOf = (attachment: T): string | undefined => (attachment.status === `failed` ? (attachment.error ?? `Upload failed`) : undefined);
</script>

<template>
    <!-- `items-start`: a tile beside a thumbnail must keep its own height, not stretch to the picture's and read as an empty box. -->
    <!-- A sent row's `gap-3`: with no box of their own, two attachments need the space between them to do the separating. -->
    <div class="flex items-start" :class="staged ? `gap-2` : `gap-3`">
        <!-- What rides along with the attachments without being one (the composer's editor-context chip). -->
        <slot />
        <!-- A staged path is unique and fixed, so its chip outlives the swap from its own bytes to the uploaded copy. -->
        <template v-for="attachment in attachments" :key="attachment.path">
            <ChatAudioChip
                v-if="attachmentKind(attachment.path) === `audio`"
                :name="attachment.name"
                :path="attachment.path"
                :src="landed(attachment) ? attachmentAudio(attachment.path) : attachment.previewUrl"
                :progress="progressOf(attachment)"
                :error="errorOf(attachment)"
                :framed="staged"
                :removable="staged"
                @remove="emit(`remove`, attachment)"
            />
            <ChatImageThumb v-else-if="!staged && pictureOf(attachment)" :src="pictureOf(attachment)!" :alt="attachment.name" size="h-14 w-14" />
            <ChatFileChip
                v-else
                :name="attachment.name"
                :path="attachment.path"
                :peek="landed(attachment) ? attachmentPeek(attachment.path) : undefined"
                :preview-url="pictureOf(attachment)"
                :lead="staged ? 0 : LEAD_LINES"
                :progress="progressOf(attachment)"
                :error="errorOf(attachment)"
                :framed="staged"
                :removable="staged"
                @remove="emit(`remove`, attachment)"
            />
        </template>
    </div>
</template>
