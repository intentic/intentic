<script setup lang="ts">
import { computed } from "vue";
import { providerGroupLabel } from "../../chat/accounts/providerCatalog";
import { formatUsd, niceMax, providerColor, type SpendBucket } from "./usageChart";

// Spend over time as columns; a single series shows no legend (the title already names it), two or more get one.
// Hand-rolled in HTML, not SVG or a library: percentage heights in a flex row are already responsive (no resize
// observer needed), and colours are theme-aware CSS variables.

// `providers` are series keys, not provider ids (locals folded into one); labelled via the group label.
const { series, providers } = defineProps<{ series: readonly SpendBucket[]; providers: readonly string[] }>();

// Axis top from the column's own total, never the stacked segments, for gridlines that read as round numbers.
const max = computed(() => niceMax(Math.max(0, ...series.map((bucket) => bucket.totals.costUsd))));

const stacked = computed(() => providers.length > 1);

// Reversed (flex paints first child on top); zero segments dropped here so an idle provider adds no gap.
const stackOf = (bucket: SpendBucket): { key: string; value: number }[] => bucket.segments.filter((segment) => segment.value > 0).toReversed();

const tooltipFor = (bucket: SpendBucket): string =>
    [
        `${bucket.label} · ${formatUsd(bucket.totals.costUsd)}`,
        ...(stacked.value ? stackOf(bucket).map((segment) => `${providerGroupLabel(segment.key)} ${formatUsd(segment.value)}`) : []),
        `${bucket.totals.turns} ${bucket.totals.turns === 1 ? `turn` : `turns`}`,
    ].join(` · `);

const PLOT_HEIGHT = `10rem`;
</script>

<template>
    <figure class="flex flex-col gap-2">
        <!-- Two or more series always carry a legend: identity must never rest on colour-matching alone. -->
        <figcaption v-if="stacked" class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span v-for="provider in providers" :key="provider" class="flex items-center gap-1.5 text-2xs text-muted">
                <span class="size-2 shrink-0 rounded-2xs" :style="{ background: providerColor(provider) }" />
                {{ providerGroupLabel(provider) }}
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
                <div v-for="tick in [0, 50, 100]" :key="tick" class="absolute inset-x-0 border-t border-line-subtle" :style="{ top: `${tick}%` }" />

                <div class="absolute inset-0 flex items-end gap-0.5">
                    <!-- Hit target is the whole band, not the mark: a $0.02 day is 1px tall and otherwise unhoverable. -->
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

        <!-- Only the ends are labelled; a tick per column is unreadable, and the tooltip names the hovered one. -->
        <div v-if="series.length > 0" class="flex justify-between pl-13 text-2xs text-subtle">
            <span>{{ series[0]?.label }}</span>
            <span v-if="series.length > 1">{{ series.at(-1)?.label }}</span>
        </div>
    </figure>
</template>
