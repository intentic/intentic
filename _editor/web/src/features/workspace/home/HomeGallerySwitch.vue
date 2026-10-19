<!-- The home bar's gallery switch, in words like the grouping beside it, with the size slider while the gallery is on. -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { GALLERY_HEIGHT_MAX, GALLERY_HEIGHT_MIN, GALLERY_HEIGHT_STEP, galleryHeight } from "./galleryChoice";

const t = useT();

const { on } = defineProps<{ on: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
    <!-- The size rides beside the switch while it is on, as a photo library's zoom does, never in a menu: on its left, so
         turning the gallery off moves nothing under the pointer that turned it off. -->
    <span class="flex items-center gap-1.5" @click.stop @contextmenu.stop>
        <input
            v-if="on"
            v-model.number="galleryHeight"
            type="range"
            class="w-20 accent-primary-500"
            :min="GALLERY_HEIGHT_MIN"
            :max="GALLERY_HEIGHT_MAX"
            :step="GALLERY_HEIGHT_STEP"
            :aria-label="t(`workspace.homeView.gallerySize`)"
            v-tooltip.bottom="t(`workspace.homeView.gallerySize`)"
            aria-keyshortcuts="- +"
            @keydown.stop
        />
        <button
            type="button"
            class="ui-chip h-6 gap-1.5 px-2 text-xs transition-colors"
            :class="on ? 'text-accent' : 'text-muted hover:text-content'"
            :aria-pressed="on"
            v-tooltip.bottom="on ? t(`workspace.homeView.galleryOffHint`) : t(`workspace.homeView.galleryOnHint`)"
            @click="emit('toggle')"
        >
            <Icon name="image" aria-hidden="true" />
            {{ t(`workspace.homeView.gallery`) }}
        </button>
    </span>
</template>
