<!-- The single icon primitive for the app: draws the native SVG paths in icons/iconSets.ts. -->
<script setup lang="ts">
import { computed, useAttrs } from "vue";
import { ICONS, type IconName } from "../../icons/iconSets.js";
import { useCompositedLoops, useReducedMotion } from "../../composables/useReducedMotion.js";
import type { Glyph } from "../../icons/glyph.js";

const { name, spin = false } = defineProps<{ name: IconName; spin?: boolean }>();

// Attrs aren't reactive; read them during rendering so a changed accessible name is respected.
const attrs = useAttrs();
const label = (): string | undefined => {
    for (const key of [`aria-label`, `ariaLabel`, `title`]) {
        const value = attrs[key];
        if (typeof value === `string` && value.length > 0) {
            return value;
        }
    }
    return undefined;
};
const drawing = computed<Glyph>(() => ICONS[name]);

/* The spinner is drawn against the pack's own rules, because it is the only glyph that moves and moving geometry has different needs from still geometry. */
const isSpinner = computed(() => name === `spinner`);
const SPINNER_STROKE = 2.5;

// The whole glyph turns as a CSS animation on the compositor, save under a desktop pointer in a developer's build, which
// keeps SMIL and so leaves DevTools' Styles editor alone (useCompositedLoops says why each). The reduced-motion query is
// only asked while SMIL turns.
const composited = useCompositedLoops();
const turnsOnCompositor = computed(() => spin && composited.value);
const reducedMotion = useReducedMotion(() => spin && !composited.value);
const turnsBySmil = computed(() => spin && !turnsOnCompositor.value);
</script>

<template>
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width="1em"
        height="1em"
        role="img"
        focusable="false"
        :aria-hidden="label() !== undefined || attrs['aria-labelledby'] ? undefined : true"
        :aria-label="label()"
        class="ui-icon"
        :class="{ 'ui-icon-turning': turnsOnCompositor }"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="square"
        stroke-linejoin="miter"
        stroke-miterlimit="2"
        :shape-rendering="isSpinner ? `geometricPrecision` : undefined"
    >
        <!-- The pack's ink is set on the <svg> itself and inherited, so a still glyph is the svg and its paths: no group
             of its own, on the most numerous element in the app. -->
        <!-- The circle the spinner's arc travels, at a quiet fraction of the same ink. -->
        <circle v-if="isSpinner" cx="12" cy="12" r="8.75" :stroke-width="SPINNER_STROKE" opacity="0.35" />
        <!-- Everything that turns, and only what turns: the one group, drawn only where something does. -->
        <g v-if="isSpinner || turnsBySmil" :stroke-width="isSpinner ? SPINNER_STROKE : undefined" :stroke-linecap="isSpinner ? `round` : undefined">
            <path v-if="drawing.outline" :d="drawing.outline" />
            <path v-if="drawing.solid" :d="drawing.solid" fill="currentColor" stroke="none" />
            <!-- SMIL leaves DevTools' CSS animation model alone. Reduced motion keeps the slower spinner. -->
            <animateTransform
                v-if="turnsBySmil"
                attributeName="transform"
                type="rotate"
                from="0 12 12"
                to="360 12 12"
                :dur="reducedMotion ? `3s` : `1.1s`"
                repeatCount="indefinite"
            />
        </g>
        <template v-else>
            <path v-if="drawing.outline" :d="drawing.outline" />
            <path v-if="drawing.solid" :d="drawing.solid" fill="currentColor" stroke="none" />
        </template>
    </svg>
</template>

<style scoped>
/* THE SPINNER ON THE COMPOSITOR (useCompositedLoops): the whole glyph turns as one composited layer, rasterised once and rotated off the main
   thread. Its track is a full circle about the centre, so turning it with the arc changes nothing the eye can see.
   Reduced motion slows it to the SMIL spinner's 3s rather than stopping it: a still mark beside live work reads as hung. */
.ui-icon-turning {
    animation: ui-icon-turn 1.1s linear infinite;
}

@keyframes ui-icon-turn {
    to {
        transform: rotate(1turn);
    }
}

@media (prefers-reduced-motion: reduce) {
    .ui-icon-turning {
        animation-duration: 3s;
    }
}
</style>
