<script setup lang="ts">
import type { TranscriptEditorContext } from "@intentic/sandbox-contract/events/transcript";
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useChatSurface } from "../../../../models/conversations/tools/chatToolSurface";

/* What a sent message said the person was looking at (the composer's "Viewing" chip): the file and lines, not an attachment, so it reads as a quiet line above the prompt rather than a file tile. A press opens it there. */

const { context } = defineProps<{ context: TranscriptEditorContext }>();
const t = useT();
const surface = useChatSurface();

const name = computed(() => {
    const base = context.file.split(`/`).pop() ?? context.file;
    return context.startLine === undefined ? base : `${base}:${context.startLine}-${context.endLine ?? context.startLine}`;
});
const open = (): void => {
    void surface.openFile?.(context.file, context.startLine);
};
</script>

<template>
    <button
        type="button"
        class="flex max-w-full items-center gap-1 text-2xs text-muted enabled:hover:text-content"
        :disabled="surface.openFile === undefined"
        :title="context.file"
        :aria-label="t(`chat.chatPane.viewingLabel`, { file: context.file })"
        @click="open"
    >
        <Icon name="eye" class="shrink-0" />
        <span class="truncate">{{ t(`chat.chatPane.viewing`) }} {{ name }}</span>
    </button>
</template>
