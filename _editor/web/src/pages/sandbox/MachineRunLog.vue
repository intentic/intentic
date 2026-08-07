<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

/* WHAT THE COMPUTER IS SAYING WHILE IT WORKS.
 *
 * An update pulls an image and recreates a container: minutes in which the only honest thing a button can do is
 * show the machine's own output. The lines are `ic`'s, verbatim and unsummarised — the same argument the desktop
 * app makes for promoting the script's output instead of inventing a progress model beside it. A step this view
 * invented would be a second account of the flow, and the two would drift.
 *
 * Follows the tail while it runs, and stops following the moment the reader scrolls up — someone reading an error
 * that went past should not be dragged back down by the next line. */

const props = defineProps<{ lines: readonly string[]; running: boolean }>();

const pane = ref<HTMLElement | undefined>(undefined);
const following = ref(true);

// "At the bottom" with a few pixels of slack: an exact comparison is false on fractional scroll heights, which is
// most of them at non-integer zoom.
const onScroll = (): void => {
    const element = pane.value;
    if (element !== undefined) {
        following.value = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    }
};

watch(
    () => props.lines.length,
    async () => {
        if (!following.value) {
            return;
        }
        await nextTick();
        const element = pane.value;
        if (element !== undefined) {
            element.scrollTop = element.scrollHeight;
        }
    },
);
</script>

<template>
    <div class="flex flex-col gap-1">
        <div
            ref="pane"
            class="max-h-48 overflow-auto rounded-lg border border-line bg-canvas p-2 font-mono text-2xs leading-relaxed text-subtle"
            @scroll="onScroll"
        >
            <p v-if="lines.length === 0" class="text-muted">Starting on that computer…</p>
            <p v-for="(line, index) in lines" :key="index" class="whitespace-pre-wrap break-all">{{ line }}</p>
        </div>
        <p v-if="running" class="flex items-center gap-1.5 text-2xs text-muted">
            <Icon name="refresh" spin />
            <span>Running on that computer — it keeps going even if you leave this page.</span>
        </p>
    </div>
</template>
