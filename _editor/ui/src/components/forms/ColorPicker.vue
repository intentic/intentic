<!--
    The app's colour picker: a fixed row of swatches, not a wheel or hex field, since the accent is always used at one fixed lightness
    (themeColor.ts). Swatch order runs the hue wheel from the default; grey ends the row.
-->
<script setup lang="ts">
import { type Accent, accentHex } from "../../lib/themeColor.js";

/** The accent, as `#rrggbb`: always one of the swatches below. */
const model = defineModel<string>({ required: true });

const PRESETS: readonly (Accent & { readonly label: string })[] = [
    // Ember is at full saturation on purpose: it is DEFAULT_ACCENT exactly, so a workspace nobody has
    // recoloured shows this swatch as the selected one rather than none of them.
    { label: `Ember`, hue: 55, saturation: 1 },
    { label: `Vermilion`, hue: 25, saturation: 0.85 },
    { label: `Rose`, hue: 350, saturation: 0.78 },
    { label: `Orchid`, hue: 320, saturation: 0.8 },
    { label: `Iris`, hue: 290, saturation: 0.85 },
    { label: `Cobalt`, hue: 260, saturation: 0.9 },
    { label: `Azure`, hue: 230, saturation: 0.95 },
    { label: `Lagoon`, hue: 200, saturation: 1 },
    { label: `Emerald`, hue: 172, saturation: 0.95 },
    { label: `Fern`, hue: 145, saturation: 0.85 },
    { label: `Moss`, hue: 115, saturation: 0.9 },
    { label: `Brass`, hue: 85, saturation: 0.95 },
    { label: `Graphite`, hue: 250, saturation: 0.14 },
];
const presets = PRESETS.map((preset) => ({ label: preset.label, hex: accentHex(preset) }));
</script>

<template>
    <!-- A radiogroup rather than a row of toggles: this is one exclusive choice, and every swatch is focusable
         so it can be reached and taken without a pointer. -->
    <div role="radiogroup" aria-label="Accent colour" class="flex flex-wrap items-center gap-2.5">
        <button
            v-for="preset in presets"
            :key="preset.label"
            type="button"
            role="radio"
            :aria-checked="model === preset.hex"
            :aria-label="preset.label"
            v-tooltip.bottom="preset.label"
            class="size-7 cursor-pointer rounded-full border transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60"
            :class="
                model === preset.hex
                    ? // A ring held OFF the swatch by the row's own background, rather than an outline drawn on
                      // its edge: half these colours are pale and half are deep, and only a gap reads as
                      // 'chosen' against both.
                      `border-transparent ring-2 ring-content ring-offset-2 ring-offset-card`
                    : `border-line`
            "
            :style="{ background: preset.hex }"
            @click="model = preset.hex"
        />
    </div>
</template>
