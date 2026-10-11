<script setup lang="ts" generic="T extends string">
import { useTemplateRef } from "vue";
import { useSwipePager } from "./swipePager";

// Pages side by side that a finger turns (swipePager.ts says how). One slot per page, named by its id; each page fills
// the pager and keeps its own scroll, since none is ever unmounted by turning away from it. The page out of view is
// inert: nothing in it takes focus or a screen reader's attention while the reader is on its neighbour.

const { pages, follower, idPrefix } = defineProps<{
    /** The pages, in the order a finger meets them. A page added later joins without disturbing the ones drawn. */
    pages: readonly T[];
    /** What moves along with the pages to say which one shows (the switch's thumb), if anything does. */
    follower?: HTMLElement | null;
    /** Prefix of each page's id, which the switch's tabs name in `aria-controls`. */
    idPrefix: string;
}>();

const page = defineModel<T>({ required: true });
const emit = defineEmits<{
    /** A finger came down where it could turn the page: have the neighbour ready. */
    wake: [];
}>();

const surface = useTemplateRef<HTMLElement>(`surface`);
// A v-for's ref array keeps no order of its own, so each page is found by the id it carries.
const drawn = useTemplateRef<HTMLElement[]>(`drawn`);

useSwipePager({
    surface,
    pages: () => pages.map((id) => drawn.value?.find((el) => el.dataset[`page`] === id)),
    follower: () => follower,
    index: () => Math.max(0, pages.indexOf(page.value)),
    select: (index) => {
        const id = pages[index];
        if (id !== undefined) {
            page.value = id;
        }
    },
    wake: () => emit(`wake`),
});
</script>

<template>
    <!-- `overflow-clip`, not hidden: a clipped box is no scroller, so focusing something in the page out of view can't
         scroll the pager sideways under the transforms. -->
    <div ref="surface" class="relative min-h-0 flex-1 overflow-clip">
        <section
            v-for="id in pages"
            :id="`${idPrefix}-${id}`"
            ref="drawn"
            :key="id"
            :data-page="id"
            role="tabpanel"
            class="absolute inset-0 flex min-h-0 flex-col"
            :inert="id === page ? undefined : true"
        >
            <slot :name="id" />
        </section>
    </div>
</template>
