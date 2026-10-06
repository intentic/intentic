<script setup lang="ts">
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useChatFloating } from "../../features/chat/panel/chatFloating";
import { commandShortcut } from "../../workbench/commands/useCommands";
import RailIcon from "./RailIcon.vue";
import { type ChatDragPhase, GRAB } from "./chatTileDrag";

// WHAT CARRYING THE CHAT TILE OFF THE RAIL WILL DO, drawn while it is carried (chatTileDrag.ts). Everything outside the
// rail is one target, so it is marked as one: a dashed rim around all of it from the moment the tile lifts. Over the
// rail the tile itself rides the pointer and a card says where to take it. Outside, the tile becomes the window it will
// be: an outline at the size that window opens at, its title bar under the pointer where the window's will be, saying in
// words what letting go does and how to undo it. A shield over the whole shell while it lasts: one cursor, no hover
// underneath, and no iframe swallowing the pointer on the way across.

const { phase, pointer, railRight } = defineProps<{
    phase: ChatDragPhase;
    // Viewport pixels.
    pointer: { readonly x: number; readonly y: number };
    // Where the rail ends, in viewport pixels: the target starts there.
    railRight: number;
}>();

const t = useT();
// Read once: the layer comes and goes with one drag, and the size cannot change under a held pointer.
const size = useChatFloating().openingSize();
const dockKeys = commandShortcut(`chat.toggleFloating`);
const out = computed(() => phase === `out`);

const windowStyle = computed(() => ({
    width: `${size.width}px`,
    height: `${size.height}px`,
    transform: `translate3d(${pointer.x - GRAB.x}px, ${pointer.y - GRAB.y}px, 0)`,
}));
const tileStyle = computed(() => ({ transform: `translate3d(${pointer.x}px, ${pointer.y}px, 0) translate(-50%, -50%)` }));
</script>

<template>
    <!-- Decoration for a pointer gesture: the tile's own menu and F9 are what a screen reader is offered instead. -->
    <div class="fixed inset-0 z-[900] cursor-grabbing select-none overflow-hidden" aria-hidden="true" data-window-no-drag>
        <!-- The target: everything right of the rail, the side panel included. -->
        <div class="absolute inset-y-0 right-0" :style="{ left: `${railRight}px` }">
            <div
                class="absolute inset-2 rounded-xl border-2 border-dashed transition-colors duration-150"
                :class="out ? `border-primary-500/70 bg-primary-500/10` : `border-primary-500/40 bg-primary-500/5`"
            ></div>
            <div v-if="!out" class="absolute inset-0 flex items-center justify-center p-6">
                <div class="flex items-center gap-2.5 rounded-lg border border-line-strong bg-card px-3.5 py-2.5 text-sm text-content shadow-lg">
                    <Icon name="external-link" class="shrink-0 text-base text-link" />
                    <span>{{ t(`shell.shellDesktop.chatDropInvite`) }}</span>
                    <span class="text-xs text-subtle">{{ t(`shell.shellDesktop.chatDropCancel`) }}</span>
                </div>
            </div>
        </div>

        <!-- Outside the rail: the window to be, where and as large as it will open. -->
        <div
            v-if="out"
            class="absolute left-0 top-0 flex flex-col overflow-hidden rounded-lg border-2 border-primary-500 bg-card/85 shadow-2xl"
            :style="windowStyle"
        >
            <div class="flex h-7 shrink-0 items-center gap-1.5 border-b border-primary-500/30 bg-primary-500/15 px-2 text-xs">
                <RailIcon section="chat" class="text-sm text-link" />
                <span class="font-medium text-content">{{ t(`shared.chat`) }}</span>
                <span class="rounded bg-primary-500/15 px-1.5 py-px text-2xs font-medium text-link">{{ t(`shell.shellDesktop.chatDropNewWindow`) }}</span>
            </div>
            <div class="flex flex-1 justify-center px-6 pt-16">
                <div class="flex max-w-80 flex-col items-center gap-2 text-center">
                    <span class="flex h-11 w-11 items-center justify-center rounded-full bg-primary-500/15 text-link">
                        <Icon name="external-link" class="text-xl" />
                    </span>
                    <p class="text-sm font-medium text-content">{{ t(`shell.shellDesktop.chatDropRelease`) }}</p>
                    <p class="text-xs text-muted">
                        <template v-if="dockKeys !== undefined">{{ t(`shell.shellDesktop.chatDropDockBack`, { keys: dockKeys }) }} · </template
                        >{{ t(`shell.shellDesktop.chatDropCancel`) }}
                    </p>
                </div>
            </div>
        </div>

        <!-- Over the rail: the tile itself, lifted off its place. -->
        <div
            v-else
            class="icon-rail-tile absolute left-0 top-0 flex items-center justify-center rounded-lg bg-card text-link shadow-lg ring-2 ring-primary-500"
            :style="tileStyle"
        >
            <RailIcon section="chat" class="icon-rail-glyph" />
        </div>
    </div>
</template>
