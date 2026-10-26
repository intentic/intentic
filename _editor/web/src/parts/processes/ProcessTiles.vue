<!-- THE RAIL'S TEMPORARY GROUP (models/processes/processTiles.ts): a tile per process under way, drawn the same on Home's
     rail, the sandbox rail and This computer's, worn like every other tile (a glyph or the sandbox's letters, a mark in the
     top corner for news, the spinning mark in the bottom one while it works). A press opens its page in the face the
     reader is in; each rail says where by `open`. Nothing when nothing runs, divider included. -->
<script setup lang="ts">
import { SandboxLogo } from "@intentic/ui";
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import TileMark from "../../components/TileMark.vue";
import type { ProcessTile } from "../../models/processes/processTiles";
import ViewBadgeChip from "../../workbench/views/ViewBadgeChip.vue";
import { RUNNING_MARK_CLASS } from "../../workbench/views/viewBadge";

const { tiles, selected = undefined } = defineProps<{ tiles: readonly ProcessTile[]; selected?: string | undefined }>();
const emit = defineEmits<{ open: [tile: ProcessTile] }>();
const t = useT();
</script>

<template>
    <template v-if="tiles.length > 0">
        <span class="my-1 icon-rail-divider h-px shrink-0 bg-line" aria-hidden="true"></span>
        <div role="group" :aria-label="t(`processes.group`)" class="flex shrink-0 flex-col items-center" data-process-tiles>
            <button
                v-for="tile in tiles"
                :key="tile.id"
                type="button"
                class="icon-rail-tile ui-row-select ui-row-select-horizontal relative flex items-center justify-center rounded-lg text-muted hover:text-content"
                :class="{ 'ui-row-select-on text-link': selected === tile.id }"
                :aria-label="`${tile.title} · ${tile.note}`"
                :aria-current="selected === tile.id ? 'true' : undefined"
                v-tooltip.right="{ title: tile.title, note: tile.note }"
                :data-process-tile="tile.report.kind"
                :data-state="tile.report.state"
                @click="emit(`open`, tile)"
            >
                <SandboxLogo v-if="`logo` in tile.glyph" :image="null" :name="tile.glyph.logo" class="rounded-lg" />
                <Icon v-else :name="tile.glyph.icon" class="icon-rail-glyph" aria-hidden="true" />
                <ViewBadgeChip :badge="tile.badge" class="icon-rail-mark absolute right-0.5 top-0.5" />
                <TileMark
                    v-if="tile.badge?.running !== undefined"
                    name="spinner"
                    spin
                    :class="[RUNNING_MARK_CLASS, `icon-rail-mark absolute bottom-0.5 right-0.5`]"
                />
            </button>
        </div>
    </template>
</template>
