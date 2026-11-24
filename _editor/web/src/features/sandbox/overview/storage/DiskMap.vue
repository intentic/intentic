<script setup lang="ts">
import type { StorageScan } from "@intentic/sandbox-contract/schemas/metrics";
import type { Tip } from "@intentic/ui";
import { formatBytes, formatPercent } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted, ref, useId } from "vue";
import { NEAR_LIMIT } from "../../../../models/sandbox/liveMetrics";
import {
    DISK_GROUPS,
    type DiskGroup,
    type DiskSegment,
    type DiskTile,
    diskSegments,
    GROUP_SWATCH,
    groupBytes,
    mapTiles,
    sandboxShare,
    squarify,
} from "./diskMap";
import { diskGroupLabel, storageCategoryLabel } from "./storageCategories";
import { shareOfCounted } from "./storageView";

// The disk drawn to scale (2026-11-24). The bar is the whole volume: what the sandbox holds, by what the reader can do
// about it, then what the volume reports used that the sandbox does not hold, hatched, on a track of the free space.
// Under it the sandbox's own stretch opens into a treemap, every tile as big as what it holds, so the largest things
// are the first things seen; a press on one opens its page (StoragePage.vue). Categories under a hundredth of the
// sandbox share one tile (diskMap.ts mapTiles), which opens the list of them.

const t = useT();
const { scan } = defineProps<{ scan: StorageScan }>();
const emit = defineEmits<{ open: [tile: DiskTile] }>();

const hatchId = useId();
const clipId = useId();

const segments = computed(() => diskSegments(scan));
const zoomEnd = computed(() => (segments.value === undefined ? undefined : sandboxShare(segments.value)));
const disk = computed(() => {
    const volume = scan.disk;
    if (volume === undefined || volume.totalBytes <= 0) {
        return undefined;
    }
    return { ...volume, freeBytes: Math.max(0, volume.totalBytes - volume.usedBytes), near: volume.usedBytes / volume.totalBytes >= NEAR_LIMIT };
});

// The group colours as fills and as tiles, from the one table the legend's swatches read (GROUP_SWATCH).
const FILL = { free: `fill-primary-fill`, yours: `fill-content/25`, own: `fill-content/12` } as const satisfies Record<DiskGroup, string>;
const TILE = {
    free: `${GROUP_SWATCH.free} text-fill-content`,
    yours: `${GROUP_SWATCH.yours} text-content`,
    own: `${GROUP_SWATCH.own} text-content`,
} as const satisfies Record<DiskGroup, string>;

const segmentTip = (segment: DiskSegment): Tip => ({
    title: diskGroupLabel(segment.key),
    rows: [{ label: t(`sandbox.diskMap.size`), value: formatBytes(segment.bytes) }],
    note: segment.key === `outside` ? t(`sandbox.diskMap.outsideNote`) : undefined,
});

const legend = computed(() => [
    ...DISK_GROUPS.map((group) => ({ key: group, bytes: groupBytes(scan.categories, group) })),
    { key: `outside` as const, bytes: segments.value?.find((segment) => segment.key === `outside`)?.bytes ?? 0 },
].filter((entry) => entry.bytes > 0));

// The map's own box, measured, since a treemap is laid in pixels: a phone's column and a side panel opening both
// change it, and a width read once would leave the tiles where the old one put them.
const box = ref<HTMLElement>();
const size = ref({ width: 0, height: 0 });
let observer: ResizeObserver | undefined;
onMounted(() => {
    if (box.value === undefined) {
        return;
    }
    observer = new ResizeObserver(([entry]) => {
        if (entry !== undefined) {
            size.value = { width: entry.contentRect.width, height: entry.contentRect.height };
        }
    });
    observer.observe(box.value);
});
onBeforeUnmount(() => observer?.disconnect());

// Each tile a pixel in from its neighbours, so two of one colour still read as two.
const GAP = 1;
// Below these a tile drops its name, then its size too: the hover still says both.
const NAMED = { width: 84, height: 40 };
const SIZED = { width: 52, height: 24 };

const tileLabel = (tile: DiskTile): string =>
    tile.kind === `category` ? storageCategoryLabel(tile.id) : t(`sandbox.diskMap.smaller`, { count: tile.ids.length }, tile.ids.length);

const tiles = computed(() =>
    squarify(mapTiles(scan.categories), size.value.width, size.value.height).map((tile) => ({
        tile,
        key: tile.kind === `category` ? tile.id : `smaller`,
        label: tileLabel(tile),
        look: tile.kind === `category` ? TILE[tile.group] : TILE.own,
        named: tile.w >= NAMED.width && tile.h >= NAMED.height,
        sized: tile.w >= SIZED.width && tile.h >= SIZED.height,
        style: {
            left: `${tile.x + GAP}px`,
            top: `${tile.y + GAP}px`,
            width: `${Math.max(0, tile.w - 2 * GAP)}px`,
            height: `${Math.max(0, tile.h - 2 * GAP)}px`,
        },
        tip: {
            title: tileLabel(tile),
            rows: [
                { label: t(`sandbox.diskMap.size`), value: formatBytes(tile.bytes) },
                { label: t(`sandbox.diskMap.ofSandbox`), value: formatPercent(shareOfCounted(tile.bytes, scan)) },
            ],
        } satisfies Tip,
    })),
);
</script>

<template>
    <div class="flex flex-col">
        <template v-if="disk && segments">
            <svg
                class="h-2.5 w-full"
                role="img"
                :aria-label="t(`sandbox.sandboxStorageCard.diskUsed`, { used: formatBytes(disk.usedBytes), total: formatBytes(disk.totalBytes) })"
            >
                <defs>
                    <pattern :id="hatchId" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
                        <rect width="1.5" height="4" class="fill-content/35" />
                    </pattern>
                    <clipPath :id="clipId"><rect width="100%" height="100%" rx="5" /></clipPath>
                </defs>
                <g :clip-path="`url(#${clipId})`">
                    <rect width="100%" height="100%" class="fill-content/6" />
                    <rect
                        v-for="segment in segments"
                        :key="segment.key"
                        :x="`${segment.start * 100}%`"
                        :width="`${segment.size * 100}%`"
                        height="100%"
                        :class="segment.key === `outside` ? `` : FILL[segment.key]"
                        :fill="segment.key === `outside` ? `url(#${hatchId})` : undefined"
                        v-tooltip.top="segmentTip(segment)"
                    />
                </g>
            </svg>
            <div class="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 text-xs tabular-nums">
                <p :class="disk.near ? `text-warning` : `text-content`">
                    {{ t(`sandbox.sandboxStorageCard.diskUsed`, { used: formatBytes(disk.usedBytes), total: formatBytes(disk.totalBytes) }) }}
                </p>
                <p class="text-muted">{{ t(`sandbox.sandboxStorageCard.diskFree`, { bytes: formatBytes(disk.freeBytes) }) }}</p>
            </div>
            <!-- The sandbox's stretch of the bar, opened out to the map's whole width. -->
            <svg v-if="zoomEnd !== undefined && zoomEnd > 0" class="h-3 w-full" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true">
                <polygon :points="`0,0 ${zoomEnd * 100},0 100,12 0,12`" class="fill-content/5" />
            </svg>
        </template>

        <div ref="box" class="relative h-48" role="group" :aria-label="t(`sandbox.diskMap.label`)">
            <button
                v-for="entry in tiles"
                :key="entry.key"
                type="button"
                class="absolute flex cursor-pointer flex-col items-start gap-0.5 overflow-hidden rounded-md px-2 py-1.5 text-left outline-none hover:ring-2 hover:ring-content/25 hover:ring-inset focus-visible:ring-2 focus-visible:ring-primary-500/60"
                :class="entry.look"
                :style="entry.style"
                :data-disk-tile="entry.key"
                :aria-label="`${entry.label}, ${formatBytes(entry.tile.bytes)}`"
                v-tooltip.top="entry.tip"
                @click="emit(`open`, entry.tile)"
            >
                <span v-if="entry.named" class="w-full truncate text-xs font-medium" aria-hidden="true">{{ entry.label }}</span>
                <span v-if="entry.sized" class="whitespace-nowrap text-2xs tabular-nums opacity-80" aria-hidden="true">{{ formatBytes(entry.tile.bytes) }}</span>
            </button>
        </div>

        <ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted">
            <li v-for="entry in legend" :key="entry.key" class="flex items-center gap-1.5 tabular-nums">
                <svg v-if="entry.key === `outside`" class="size-2.5 shrink-0 rounded-xs" aria-hidden="true">
                    <rect width="100%" height="100%" class="fill-content/6" />
                    <rect width="100%" height="100%" :fill="`url(#${hatchId})`" />
                </svg>
                <span v-else class="size-2.5 shrink-0 rounded-xs" :class="GROUP_SWATCH[entry.key]" aria-hidden="true" />
                <span>{{ diskGroupLabel(entry.key) }}</span>
                <span class="text-subtle">{{ formatBytes(entry.bytes) }}</span>
            </li>
        </ul>
    </div>
</template>
