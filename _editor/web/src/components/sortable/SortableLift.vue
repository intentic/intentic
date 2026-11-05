<!-- THE ITEM LIFTED OFF A SORTABLE LIST (sortableDrag.ts), drawn over the page so no scrolling frame clips it: a copy of
     the item, raised a little and shadowed as a card held above the page is, following the pointer, then gliding into
     the slot it was let go over. The slot is the caller's own item, drawn empty and dashed while it is carried. -->
<script setup lang="ts">
import { computed } from "vue";
import { SETTLE_MS, type SortableLiftBox } from "./sortableDrag";

const { box } = defineProps<{ box: SortableLiftBox | undefined }>();

const style = computed(() =>
    box === undefined
        ? {}
        : {
              left: `${box.left}px`,
              top: `${box.top}px`,
              width: `${box.width}px`,
              height: `${box.height}px`,
              transition: box.settling
                  ? `top ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1), transform ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
                  : undefined,
          },
);
</script>

<template>
    <!-- Decoration for a pointer gesture: the item's own menu is what a keyboard and a screen reader are offered instead. -->
    <Teleport to="body">
        <div
            v-if="box"
            aria-hidden="true"
            class="pointer-events-none fixed z-[1100] select-none"
            :class="box.settling ? 'scale-100' : 'scale-[1.06] motion-reduce:scale-100'"
            :style="style"
        >
            <slot />
        </div>
    </Teleport>
</template>
