<script setup lang="ts">
import { AnchoredOverlay, Icon, ProgressRing, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import type { DownloadTools } from "./useDownloadTools";
import { ringPercent, underway } from "./downloadWords";
import DownloadsList from "./DownloadsList.vue";

// The toolbar's downloads button, where a browser keeps its own: a ring around the glyph while anything arrives, and
// the list (Ctrl+J) under it. Only on a window whose downloads this browser keeps.

const { tools } = defineProps<{ tools: DownloadTools }>();
const t = useT();

const trigger = ref<HTMLElement | undefined>();
const ring = computed(() => ringPercent(tools.list.value));
const arriving = computed(() => underway(tools.list.value).length);
const label = computed(() =>
    arriving.value === 0 ? t(`browsers.tools.downloads`) : t(`browsers.tools.downloading`, { count: arriving.value }, arriving.value),
);
</script>

<template>
    <button
        ref="trigger"
        type="button"
        :class="ui.iconButton({ on: tools.open.value, size: `md`, round: true }, `relative`)"
        aria-haspopup="dialog"
        :aria-expanded="tools.open.value"
        :aria-label="label"
        v-tooltip.bottom="label"
        @click="tools.open.value = !tools.open.value"
    >
        <Icon name="download" class="text-xs" :class="ring === undefined ? '' : 'text-link'" />
        <ProgressRing v-if="ring !== undefined" :value="ring" :size="24" class="pointer-events-none absolute inset-0 m-auto text-link" />
    </button>
    <AnchoredOverlay v-model="tools.open.value" :anchor="trigger" side="bottom" cross="end">
        <DownloadsList :tools="tools" />
    </AnchoredOverlay>
</template>
