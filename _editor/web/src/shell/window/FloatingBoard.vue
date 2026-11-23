<!-- THE BOARD IN A POPPED-OUT CHAT'S WINDOW (FloatingSection.vue): the Agents page as the main window draws it (its lanes,
     search, owner filter, geek metrics, night and New agent, Usage left under it while the chat has no room for its own
     side rail), standing left of the chat the way the main window's board stands left of the docked chat, and the seam
     that sets how much of the window it takes. -->
<script setup lang="ts">
import { ResizeSeam } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { numberPreference } from "@intentic/ui/preference";
import { computed, onBeforeUnmount, ref } from "vue";
import Agents from "../../features/agents/fleet/Agents.vue";
import { uiLength } from "../../workbench/window/uiScale";

const t = useT();

// How much of the window the board takes, in thousandths, so a split chosen on a laptop reads the same on a wide screen.
// The floor leaves the board its stacked lanes; the ceiling leaves the chat a column. Below the board's own minimum width
// (MIN_BOARD_PX) the layout holds the minimum instead.
const MIN_SHARE = 250;
const MAX_SHARE = 800;
const DEFAULT_SHARE = 450;
const clampShare = (share: number): number => Math.round(Math.max(MIN_SHARE, Math.min(share, MAX_SHARE)));
const share = numberPreference(`ui-floating-board-share`, clampShare, () => DEFAULT_SHARE);

// The narrowest the board is drawn whatever its share, in app pixels: its lanes stacked, a card's title on two lines.
const MIN_BOARD_PX = 360;

// The window's width in screen pixels: the seam speaks in the pointer's pixels, the share is thousandths of this.
const room = ref(globalThis.innerWidth);
const onResize = (): void => {
    room.value = globalThis.innerWidth;
};
globalThis.addEventListener(`resize`, onResize);
onBeforeUnmount(() => globalThis.removeEventListener(`resize`, onResize));

const toPx = (part: number): number => Math.round((part / 1000) * room.value);
const seam = computed<number>({
    get: () => toPx(share.value),
    set: (px) => {
        if (room.value > 0) {
            share.value = clampShare((px / room.value) * 1000);
        }
    },
});

// The width the pointer asks for while the seam is dragged (ResizeSeam's `preview`): only this column moves until the
// release, which stores the share once.
const dragged = ref<number | undefined>(undefined);
const width = computed(() => `${dragged.value ?? toPx(share.value)}px`);
</script>

<template>
    <aside class="relative flex h-full min-h-0 border-r border-line" :style="{ width, minWidth: uiLength(MIN_BOARD_PX) }">
        <Agents class="min-w-0 flex-1" />
        <ResizeSeam
            v-model="seam"
            :min="toPx(MIN_SHARE)"
            :max="toPx(MAX_SHARE)"
            :reset="toPx(DEFAULT_SHARE)"
            :preview="(px) => (dragged = px)"
            :title="t(`ui.resizeSeam.doubleClickResets`)"
        />
    </aside>
</template>
