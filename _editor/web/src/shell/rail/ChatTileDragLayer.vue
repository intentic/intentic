<script setup lang="ts">
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { commandShortcut } from "../../workbench/commands/useCommands";
import RailIcon from "./RailIcon.vue";
import type { ChatDragPhase } from "./chatTileDrag";

// Both destinations stay visible while the tile is carried; the active one lights up immediately. A shield over the
// shell keeps hover and embedded frames from interfering with the gesture.

const { phase, pointer, railRight, dockLeft } = defineProps<{
    phase: ChatDragPhase;
    // Viewport pixels.
    pointer: { readonly x: number; readonly y: number };
    // Where the rail ends, in viewport pixels: the target starts there.
    railRight: number;
    dockLeft: number;
}>();

const t = useT();
const dockKeys = commandShortcut(`chat.toggleFloating`);
const tileStyle = computed(() => ({ transform: `translate3d(${pointer.x}px, ${pointer.y}px, 0) translate(-50%, -50%)` }));
</script>

<template>
    <!-- Decoration for a pointer gesture: the tile's own menu and F9 are what a screen reader is offered instead. -->
    <div class="fixed inset-0 z-[900] cursor-grabbing select-none overflow-hidden" aria-hidden="true" data-window-no-drag>
        <div class="absolute inset-y-0" :style="{ left: `${railRight}px`, width: `${dockLeft - railRight}px` }">
            <div
                data-chat-drop-zone="window"
                :data-active="phase === `out`"
                class="absolute inset-2 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed bg-card/90 px-6 text-center transition-colors duration-100"
                :class="phase === `out` ? `border-primary-500 text-link` : `border-line-strong text-muted`"
            >
                <Icon name="external-link" class="text-3xl" />
                <div class="flex max-w-80 flex-col gap-2">
                    <p class="text-lg font-medium text-content">{{ t(`shell.shellDesktop.chatDropNewWindow`) }}</p>
                    <p class="text-sm text-muted">{{ t(`shell.shellDesktop.chatDropRelease`) }}</p>
                    <p v-if="dockKeys !== undefined" class="text-xs text-subtle">{{ t(`shell.shellDesktop.chatDropDockBack`, { keys: dockKeys }) }}</p>
                </div>
            </div>
        </div>
        <div class="absolute inset-y-0 right-0" :style="{ left: `${dockLeft}px` }">
            <div
                data-chat-drop-zone="right"
                :data-active="phase === `dock`"
                class="absolute inset-2 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed bg-card/90 px-6 text-center transition-colors duration-100"
                :class="phase === `dock` ? `border-primary-500 text-link` : `border-line-strong text-muted`"
            >
                <Icon name="arrow-right" class="text-3xl" />
                <div class="flex max-w-80 flex-col gap-2">
                    <p class="text-lg font-medium text-content">{{ t(`shell.shellDesktop.chatDropDockRight`) }}</p>
                    <p class="text-sm text-muted">{{ t(`shell.shellDesktop.chatDropDockRelease`) }}</p>
                </div>
            </div>
        </div>
        <p class="absolute inset-x-0 bottom-6 text-center text-xs text-subtle">{{ t(`shell.shellDesktop.chatDropCancel`) }}</p>
        <!-- The tile follows the pointer without covering either destination. -->
        <div
            class="icon-rail-tile pointer-events-none absolute left-0 top-0 flex items-center justify-center rounded-lg bg-card text-link shadow-lg ring-2 ring-primary-500"
            :style="tileStyle"
        >
            <RailIcon section="chat" class="icon-rail-glyph" />
        </div>
    </div>
</template>
