<!-- The app's colour picker: a fixed row of swatches, not a wheel or hex field, since the accent is always used at one fixed lightness (themeColor.ts). -->
<script setup lang="ts">
import { type Accent, accentHex } from "../../lib/themeColor.js";
import { useT } from "../../i18n/index.js";
import { computed } from "vue";

const t = useT();

/** The accent, as `#rrggbb`: always one of the swatches below. */
const model = defineModel<string>({ required: true });

const PRESETS = computed((): readonly (Accent & { readonly label: string })[] => [
    // Ember is at full saturation on purpose: it is DEFAULT_ACCENT exactly, so a workspace nobody has
    // recoloured shows this swatch as the selected one rather than none of them.
    { label: t(`ui.colorPicker.ember`), hue: 55, saturation: 1 },
    { label: t(`ui.colorPicker.vermilion`), hue: 25, saturation: 0.85 },
    { label: t(`ui.colorPicker.rose`), hue: 350, saturation: 0.78 },
    { label: t(`ui.colorPicker.orchid`), hue: 320, saturation: 0.8 },
    { label: t(`ui.colorPicker.iris`), hue: 290, saturation: 0.85 },
    { label: t(`ui.colorPicker.cobalt`), hue: 260, saturation: 0.9 },
    { label: t(`ui.colorPicker.azure`), hue: 230, saturation: 0.95 },
    { label: t(`ui.colorPicker.lagoon`), hue: 200, saturation: 1 },
    { label: t(`ui.colorPicker.emerald`), hue: 172, saturation: 0.95 },
    { label: t(`ui.colorPicker.fern`), hue: 145, saturation: 0.85 },
    { label: t(`ui.colorPicker.moss`), hue: 115, saturation: 0.9 },
    { label: t(`ui.colorPicker.brass`), hue: 85, saturation: 0.95 },
    { label: t(`ui.colorPicker.graphite`), hue: 250, saturation: 0.14 },
]);
const presets = PRESETS.value.map((preset) => ({ label: preset.label, hex: accentHex(preset) }));
</script>

<template>
    <!-- The swatches form one exclusive, keyboard-focusable choice. -->
    <div role="radiogroup" :aria-label="t(`ui.colorPicker.accentColour`)" class="flex flex-wrap items-center gap-2.5">
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
