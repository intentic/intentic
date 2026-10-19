<!-- The home bar's gallery switch, in words like the grouping beside it, and while the gallery is on, its picture size. -->
<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { GALLERY_HEIGHT_MAX, GALLERY_HEIGHT_MIN, GALLERY_HEIGHT_STEP, galleryHeight } from "./galleryChoice";

const t = useT();

const { on } = defineProps<{ on: boolean }>();
const emit = defineEmits<{ toggle: []; resize: [step: -1 | 1] }>();

// How far along the slider the size is, for the track's filled part.
const fill = computed(() => `${((galleryHeight.value - GALLERY_HEIGHT_MIN) / (GALLERY_HEIGHT_MAX - GALLERY_HEIGHT_MIN)) * 100}%`);
</script>

<template>
    <!-- The size rides beside the switch while the gallery is on, as a photo library's zoom does, never in a menu: on its
         left, so turning the gallery off moves nothing under the pointer that turned it off. A small picture and a large
         one either side of the slider say which way is which, and step it as the - and + keys do. On a narrow bar (the
         home's nav is the container) the steps go first and the slider stays, then the switch keeps its picture alone. -->
    <span class="flex items-center gap-1.5" @click.stop @contextmenu.stop>
        <span v-if="on" class="flex items-center" role="group" :aria-label="t(`workspace.homeView.gallerySize`)">
            <button
                type="button"
                :class="ui.iconButton({ size: `xs`, round: true }, `text-[0.55rem] @max-[64rem]/home-bar:hidden`)"
                :disabled="galleryHeight <= GALLERY_HEIGHT_MIN"
                :aria-label="t(`workspace.homeView.gallerySmaller`)"
                v-tooltip.bottom="{ title: t(`workspace.homeView.gallerySmaller`), keys: `-` }"
                @click="emit('resize', -1)"
            >
                <Icon name="image" aria-hidden="true" />
            </button>
            <input
                v-model.number="galleryHeight"
                type="range"
                class="ui-range mx-0.5 w-16"
                :style="{ '--ui-range-fill': fill }"
                :min="GALLERY_HEIGHT_MIN"
                :max="GALLERY_HEIGHT_MAX"
                :step="GALLERY_HEIGHT_STEP"
                :aria-label="t(`workspace.homeView.gallerySize`)"
                aria-keyshortcuts="- +"
                @keydown.stop
            />
            <button
                type="button"
                :class="ui.iconButton({ size: `xs`, round: true }, `text-[0.8rem] @max-[64rem]/home-bar:hidden`)"
                :disabled="galleryHeight >= GALLERY_HEIGHT_MAX"
                :aria-label="t(`workspace.homeView.galleryLarger`)"
                v-tooltip.bottom="{ title: t(`workspace.homeView.galleryLarger`), keys: `+` }"
                @click="emit('resize', 1)"
            >
                <Icon name="image" aria-hidden="true" />
            </button>
        </span>
        <button
            type="button"
            :class="ui.chip({ on }, `h-6 px-2.5 text-xs`)"
            :aria-pressed="on"
            v-tooltip.bottom="on ? t(`workspace.homeView.galleryOffHint`) : t(`workspace.homeView.galleryOnHint`)"
            @click="emit('toggle')"
        >
            <Icon name="image" aria-hidden="true" />
            <span class="@max-[48rem]/home-bar:sr-only">{{ t(`workspace.homeView.gallery`) }}</span>
        </button>
    </span>
</template>
