<!--
    The single icon primitive for the app: draws the native SVG paths in icons/iconSets.ts. Size/colour come
    from Tailwind classes on the tag. `spin` animates via SVG's own element, not CSS, so DevTools' Styles panel doesn't rebuild every frame.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useAttrs } from "vue";
import { ICONS, type IconName } from "../../icons/iconSets.js";
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

/*
 * The spinner is drawn against the pack's own rules, because it is the only glyph that moves and moving geometry has
 * different needs from still geometry. Square ends leave a nub on each tip that the eye tracks around the circle; a
 * 2-unit stroke is under a device pixel by the time the mark is 11px wide (the rail's RunningMark), so the whole arc
 * is antialiased grey and rebuilt from different sub-pixels every frame. Round ends, a heavier stroke and a still
 * track underneath — see the template — leave a ring that never moves and an arc that clearly does.
 */
const isSpinner = computed(() => name === `spinner`);
const SPINNER_STROKE = 2.5;

const reducedMotion = ref(false);
let motionQuery: MediaQueryList | undefined;
const readMotionPreference = (): void => {
    reducedMotion.value = motionQuery?.matches === true;
};
onMounted(() => {
    if (typeof window.matchMedia !== `function`) {
        return;
    }
    motionQuery = window.matchMedia(`(prefers-reduced-motion: reduce)`);
    readMotionPreference();
    motionQuery.addEventListener(`change`, readMotionPreference);
});
onBeforeUnmount(() => motionQuery?.removeEventListener(`change`, readMotionPreference));
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
    >
        <g
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="square"
            stroke-linejoin="miter"
            stroke-miterlimit="2"
            :shape-rendering="isSpinner ? `geometricPrecision` : undefined"
        >
            <!--
                The circle the spinner's arc travels, at a quiet fraction of the same ink. It sits outside the turning
                group on purpose: unmoved geometry rasterises once and then holds still, so the mark keeps a steady
                ring at any size and only the bright arc reads as motion.
            -->
            <circle v-if="isSpinner" cx="12" cy="12" r="8.75" :stroke-width="SPINNER_STROKE" opacity="0.35" />
            <!-- Everything that turns, and only what turns. -->
            <g :stroke-width="isSpinner ? SPINNER_STROKE : undefined" :stroke-linecap="isSpinner ? `round` : undefined">
                <path v-if="drawing.outline" :d="drawing.outline" />
                <path v-if="drawing.solid" :d="drawing.solid" fill="currentColor" stroke="none" />
                <!-- SMIL leaves DevTools' CSS animation model alone. Reduced motion keeps the slower spinner. -->
                <animateTransform
                    v-if="spin"
                    attributeName="transform"
                    type="rotate"
                    from="0 12 12"
                    to="360 12 12"
                    :dur="reducedMotion ? `3s` : `1.1s`"
                    repeatCount="indefinite"
                />
            </g>
        </g>
    </svg>
</template>

<style scoped>
/*
 * The svg is 1em×1em; in a flex container it would otherwise shrink to a sliver, so keep its intrinsic
 * size regardless of flex pressure.
 */
svg {
    display: inline-block;
    vertical-align: -0.125em;
    flex: none;
}
</style>
