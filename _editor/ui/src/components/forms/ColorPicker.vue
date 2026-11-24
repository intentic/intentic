<!-- The app's colour picker: a fixed row of swatches, not a wheel or hex field, since every pick is used at one fixed lightness (themeColor.ts). -->
<script setup lang="ts">
import { SWATCHES, swatchHex } from "../../lib/themeColor.js";
import { useT } from "../../i18n/index.js";
import { computed } from "vue";

const t = useT();

const { size = `md`, label } = defineProps<{ size?: `sm` | `md`; /** What is being coloured, for the group's accessible name. */ label?: string }>();

/** The colour, as `#rrggbb`: one of the swatches below once picked. */
const model = defineModel<string>({ required: true });

const presets = computed(() => SWATCHES.map((swatch) => ({ label: t(`ui.colorPicker.${swatch.key}`), hex: swatchHex(swatch) })));
</script>

<template>
    <!-- The swatches form one exclusive, keyboard-focusable choice. One line, never wrapped: on a narrow pane the swatches
         shrink a little (square, by aspect-ratio) rather than strand the last one alone on a second row. -->
    <div
        role="radiogroup"
        :aria-label="label ?? t(`ui.colorPicker.colour`)"
        class="flex min-w-0 items-center"
        :class="size === `sm` ? `gap-1.5` : `gap-2.5`"
    >
        <button
            v-for="preset in presets"
            :key="preset.label"
            type="button"
            role="radio"
            :aria-checked="model === preset.hex"
            :aria-label="preset.label"
            v-tooltip.bottom="preset.label"
            class="aspect-square min-w-0 shrink cursor-pointer rounded-full border transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60"
            :class="
                [
                    size === `sm` ? `w-6` : `w-7`,
                    model === preset.hex
                        ? // A ring held OFF the swatch by the row's own background, rather than an outline drawn on
                          // its edge: half these colours are pale and half are deep, and only a gap reads as
                          // 'chosen' against both. The gap carries that, so the ring is the accent's ink — the very
                          // colour just picked, at a weight legible on paper — not the near-black of body type,
                          // which made the chosen dot the heaviest mark on the page.
                          `border-transparent ring-2 ring-accent ring-offset-2 ring-offset-card`
                        : `border-line`,
                ]
            "
            :style="{ background: preset.hex }"
            @click="model = preset.hex"
        />
    </div>
</template>
