<!-- What a pointer drag of rows or tiles carries, riding the pointer; the surface under it lights the folder it would land in. -->
<script setup lang="ts">
import { computed } from "vue";
import { useEntryDrag } from "./useEntryDrag";

const { dragging, label, pointer, over } = useEntryDrag();
// Offset from the pointer, so the pill never sits under the cursor's own hit test.
const style = computed(() => ({ transform: `translate3d(${pointer.value.x + 14}px, ${pointer.value.y + 12}px, 0)` }));
</script>

<template>
    <div v-if="dragging" class="pointer-events-none fixed top-0 left-0 z-50" :style="style" aria-hidden="true">
        <!-- Faint over nowhere to drop; full over a folder that takes it. -->
        <div
            class="rounded-md border border-line bg-card px-2 py-1 text-xs text-content shadow-lg"
            :class="over === undefined ? 'opacity-60' : ''"
        >
            {{ label }}
        </div>
    </div>
</template>
