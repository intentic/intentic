<script setup lang="ts">
import { providerLabel } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { formatUsd, niceMax, providerColor, type SpendBucket } from "./usageChart";

/* Spend over time, as columns. One series when a single provider ran in the window (the card title names it —
 * a one-swatch legend box would only restate the title); stacked with a legend the moment there are two.
 *
 * Hand-rolled in HTML rather than SVG or a chart library: percentage heights inside a flex row are already a
 * responsive column chart, so there is no width to measure and no resize observer, and every colour is a CSS
 * custom property that flips with the theme for free. Four chart forms is well under the point where a library
 * pays for itself. */

const { series, providers } = defineProps<{ series: readonly SpendBucket[]; providers: readonly string[] }>();

// A clean axis top, so the gridline labels read as numbers a person would say. Never derived from the stacked
// segments — the column's own total is what the axis measures.
const max = computed(() => niceMax(Math.max(0, ...series.map((bucket) => bucket.totals.costUsd))));

const stacked = computed(() => providers.length > 1);

// Segments top-first, because a flex column paints its first child at the top. Zero-value segments are dropped
// here (not upstream) so a provider that didn't run on a given day contributes no 2px gap to that column.
const stackOf = (bucket: SpendBucket): { key: string; value: number }[] => bucket.segments.filter((segment) => segment.value > 0).toReversed();

const tooltipFor = (bucket: SpendBucket): string =>
    [
        `${bucket.label} · ${formatUsd(bucket.totals.costUsd)}`,
        ...(stacked.value ? stackOf(bucket).map((segment) => `${providerLabel(segment.key)} ${formatUsd(segment.value)}`) : []),
        `${bucket.totals.turns} ${bucket.totals.turns === 1 ? `turn` : `turns`}`,
    ].join(` · `);

const PLOT_HEIGHT = `10rem`;
</script>

<template>
    <figure class="flex flex-col gap-2">
        <!-- Two or more series always carry a legend: identity must never rest on colour-matching alone. -->
        <figcaption v-if="stacked" class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span v-for="provider in providers" :key="provider" class="flex items-center gap-1.5 text-2xs text-muted">
                <span class="size-2 shrink-0 rounded-[2px]" :style="{ background: providerColor(provider) }" />
                {{ providerLabel(provider) }}
            </span>
        </figcaption>

        <div class="flex gap-2">
            <!-- The axis carries the values no column is directly labelled with. -->
            <div class="flex w-11 shrink-0 flex-col justify-between text-right text-2xs tabular-nums text-subtle" :style="{ height: PLOT_HEIGHT }">
                <span class="-translate-y-1/2">{{ formatUsd(max) }}</span>
                <span class="-translate-y-1/2">{{ formatUsd(max / 2) }}</span>
                <span class="-translate-y-1/2">{{ formatUsd(0) }}</span>
            </div>

            <div class="relative min-w-0 flex-1" :style="{ height: PLOT_HEIGHT }">
                <!-- Hairline, solid, one step off the surface: a grid is scaffolding, not data. -->
                <div v-for="tick in [0, 50, 100]" :key="tick" class="absolute inset-x-0 border-t border-line" :style="{ top: `${tick}%` }" />

                <div class="absolute inset-0 flex items-end gap-0.5">
                    <!-- The hit target is the whole column band, not the mark — a $0.02 day is 1px tall and
                         would otherwise be unhoverable. The band's tint doubles as the crosshair. -->
                    <div
                        v-for="bucket in series"
                        :key="bucket.start"
                        v-tooltip.top="tooltipFor(bucket)"
                        class="flex h-full min-w-0 flex-1 cursor-default items-end justify-center rounded-sm transition-colors hover:bg-content/5"
                    >
                        <!-- Capped at 24px and centred, so a 7-column window gets air around its marks rather
                             than seven slabs. -->
                        <div class="flex w-full max-w-6 flex-col justify-end gap-0.5" :style="{ height: `${(bucket.totals.costUsd / max) * 100}%` }">
                            <div
                                v-for="(segment, index) in stackOf(bucket)"
                                :key="segment.key"
                                class="min-h-px w-full"
                                :class="index === 0 ? `rounded-t-xs` : ``"
                                :style="{ height: `${(segment.value / bucket.totals.costUsd) * 100}%`, background: providerColor(segment.key) }"
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Only the ends are labelled: a tick under every column is unreadable, and the tooltip names the one
             the reader is actually pointing at. -->
        <div v-if="series.length > 0" class="flex justify-between pl-13 text-2xs text-subtle">
            <span>{{ series[0]?.label }}</span>
            <span v-if="series.length > 1">{{ series.at(-1)?.label }}</span>
        </div>
    </figure>
</template>
