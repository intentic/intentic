<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { useTemplateRef } from "vue";
import { commandShortcut } from "../../workbench/commands/useCommands";

// THE CHAT, TUCKED AWAY: the strip it folds into at the window's edge (models/conversations/panel/chatPanelLayout.ts
// `chatTucked`), as what was opened beside folds into SideTucked. The chat stays mounted behind the edge, so a press here
// brings it back as it was left. The whole strip is the press.

const emit = defineEmits<{ reveal: [] }>();

const t = useT();

const press = useTemplateRef<HTMLButtonElement>(`press`);
// The panel hands the keyboard here when it tucks the chat away from a press inside it.
const focus = (): void => press.value?.focus();
defineExpose({ focus });
</script>

<template>
    <button
        ref="press"
        type="button"
        class="side-chat-tucked touch-target flex w-8 shrink-0 flex-col items-center gap-2 bg-card py-2 text-muted hover:bg-overlay hover:text-content"
        :aria-label="t(`shell.sidePanel.showChat`)"
        v-tooltip.left="{ title: t(`shell.sidePanel.showChat`), keys: commandShortcut(`chat.toggleTucked`) }"
        @click="emit('reveal')"
    >
        <Icon name="chevrons-left" class="text-xs" />
        <Icon name="comments" class="text-sm" />
    </button>
</template>
