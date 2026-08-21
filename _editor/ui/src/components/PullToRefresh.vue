<!-- Pull-to-refresh scroll container. When its content is at the top and a touch drags down past the
     threshold, releasing fires `onRefresh` and a spinner tracks the pull. Touch only: a mouse never triggers
     it. Wrap a list's scroll area with this and pass the query's refetch. -->
<script setup lang="ts">
import { ref } from "vue";
import Icon from "./Icon.vue";

const { onRefresh } = defineProps<{ onRefresh: () => unknown }>();

const THRESHOLD = 64; // px of pull needed to arm a refresh
const MAX = 96; // px the indicator caps at
const DAMP = 0.5; // rubber-band resistance

const scroller = ref<HTMLElement>();
const pull = ref(0);
const refreshing = ref(false);
let startY = 0;
let active = false;

const onTouchStart = (event: TouchEvent): void => {
    // Only arm when already scrolled to the very top: otherwise this is a normal scroll.
    if (refreshing.value || scroller.value === undefined || scroller.value.scrollTop > 0) {
        active = false;
        return;
    }
    startY = event.touches[0]?.clientY ?? 0;
    active = true;
};

const onTouchMove = (event: TouchEvent): void => {
    if (!active) {
        return;
    }
    const dy = (event.touches[0]?.clientY ?? 0) - startY;
    if (dy <= 0) {
        pull.value = 0;
        return;
    }
    pull.value = Math.min(MAX, dy * DAMP);
    // Suppress the native rubber-band/scroll while we own the gesture.
    event.preventDefault();
};

const onTouchEnd = async (): Promise<void> => {
    if (!active) {
        return;
    }
    active = false;
    if (pull.value < THRESHOLD) {
        pull.value = 0;
        return;
    }
    refreshing.value = true;
    pull.value = THRESHOLD;
    try {
        await onRefresh();
    } finally {
        refreshing.value = false;
        pull.value = 0;
    }
};
</script>

<template>
    <div
        ref="scroller"
        class="scrollbar-thin relative min-h-0 flex-1 overflow-auto"
        style="overscroll-behavior: contain"
        @touchstart.passive="onTouchStart"
        @touchmove="onTouchMove"
        @touchend="onTouchEnd"
        @touchcancel="onTouchEnd"
    >
        <div
            class="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center overflow-hidden"
            :style="{ height: `${pull}px` }"
        >
            <Icon name="refresh" class="text-lg text-muted" :spin="refreshing" :style="{ opacity: Math.min(1, pull / THRESHOLD) }" />
        </div>
        <div :style="pull > 0 ? { transform: `translateY(${pull}px)` } : undefined" :class="{ 'transition-transform': pull === 0 }">
            <slot />
        </div>
    </div>
</template>
