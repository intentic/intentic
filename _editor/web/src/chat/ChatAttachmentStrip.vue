<script setup lang="ts">
import ChatImageThumb from "./ChatImageThumb.vue";

/* What a sent prompt's attachments look like: a hover-previewable thumbnail per image, a name chip for
 * anything else. Only the arrangement belongs to the caller: ChatMessageView mounts one copy as the row above
 * the bubble and a second beside it, and lets a container query pick which of the two is shown. Extracted so
 * the two can't drift apart. */

defineProps<{ attachments: readonly { name: string; path: string; previewUrl?: string }[] }>();
</script>

<template>
    <div class="flex gap-1.5">
        <template v-for="attachment in attachments" :key="attachment.path">
            <ChatImageThumb v-if="attachment.previewUrl" :src="attachment.previewUrl" :alt="attachment.name" size="h-14 w-14" />
            <span v-else class="chat-surface flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-content/90">
                <Icon name="file" class="text-2xs text-subtle" />
                {{ attachment.name }}
            </span>
        </template>
    </div>
</template>
