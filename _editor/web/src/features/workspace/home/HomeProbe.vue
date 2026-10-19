<!-- The home's measure: one tile, one label and one gallery card wearing the real classes, laid out but never painted. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { HomeProbed } from "./homeLayout";

// Measured off these elements, never computed from numbers written down in a script: the grid's `auto-fill` track and
// a tile's height are the CSS's to say, and a copy of them would drift the first time someone restyled a tile. The
// home (HomeView.vue) keeps this outside its folder transition, so a folder change cannot swap the elements out from
// under the observer.
const probed = defineModel<HomeProbed>({ required: true });

const grid = ref<HTMLElement>();
const tile = ref<HTMLElement>();
const label = ref<HTMLElement>();
const galleryRow = ref<HTMLElement>();
const galleryCard = ref<HTMLElement>();

const px = (value: string): number => Number.parseFloat(value) || 0;

const MEASURED = [
    `columns`,
    `tileHeight`,
    `labelHeight`,
    `width`,
    `galleryPad`,
    `galleryGap`,
    `galleryCaption`,
] as const satisfies readonly (keyof HomeProbed)[];

const measure = (): void => {
    if (grid.value === undefined || tile.value === undefined) {
        return;
    }
    const style = getComputedStyle(grid.value);
    // The gap rides in the band height: bands are placed at an offset, so nothing else would space them apart. A gallery
    // card's frame is its padding either side, the gap between cards, and what it adds under its picture (the name and
    // the padding), this card's picture being zero tall.
    const next: HomeProbed = {
        columns: style.gridTemplateColumns.split(` `).filter((track) => track !== ``).length,
        tileHeight: tile.value.offsetHeight + px(style.rowGap),
        labelHeight: label.value?.offsetHeight ?? 0,
        width: grid.value.clientWidth,
        galleryPad: galleryCard.value === undefined ? 0 : px(getComputedStyle(galleryCard.value).paddingLeft),
        galleryGap: galleryRow.value === undefined ? 0 : px(getComputedStyle(galleryRow.value).columnGap),
        galleryCaption: galleryCard.value?.offsetHeight ?? 0,
    };
    // A pane drag fires this every frame, and a new object would re-lay the whole folder out even when nothing moved.
    const was = probed.value;
    if (MEASURED.some((key) => next[key] !== was[key])) {
        probed.value = next;
    }
};

let observer: ResizeObserver | undefined;
onMounted(() => {
    observer = new ResizeObserver(measure);
    if (grid.value !== undefined) {
        observer.observe(grid.value);
    }
    measure();
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
    <div class="pointer-events-none invisible absolute inset-x-0 top-0 px-4" aria-hidden="true">
        <div ref="grid" class="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-0.5">
            <div ref="tile" class="flex w-full flex-col items-center gap-1.5 rounded-lg px-2 pt-3 pb-2 text-center">
                <span class="flex h-14 w-full items-center justify-center"></span>
                <span class="h-[2.75em] w-full text-xs leading-snug"></span>
            </div>
        </div>
        <h3 ref="label" class="px-2 pt-3 pb-1 text-2xs text-muted">&nbsp;</h3>
        <!-- A gallery row and one card of it, as HomeGalleryTile.vue and the home's gallery band draw them. -->
        <div ref="galleryRow" class="flex gap-1">
            <div ref="galleryCard" class="flex flex-col p-1">
                <span class="block h-0"></span>
                <span class="mt-1 flex h-5 text-xs">&nbsp;</span>
            </div>
        </div>
    </div>
</template>
