<!-- The mark beside a live turn's status word: a lotus rosette whose petals light in a wave while the flower breathes. -->
<script setup lang="ts">
import { useReducedMotion } from "@intentic/ui/reduced-motion";
import { computed } from "vue";

// Drawn on the icon pack's 24×24 box at 1em and reaching r=10 like the spinner's outer edge, so swapping the two moves
// nothing on the status line. Contemplation reads as a thing that breathes; a wheel that turns reads as computation.

const COUNT = 8;
// One petal, tip out at r=10 and base at the seed; the other seven are this one rotated about the centre.
const PETAL = `M0 -10 C1.9 -6.6 1.9 -3.8 0 -1.6 C-1.9 -3.8 -1.9 -6.6 0 -10 Z`;
// Ink a petal rests at between breaths: low enough to read as unlit, high enough to hold the silhouette at 11px.
const DIM = 0.2;

// Rounded before it reaches the attribute: unrounded thirds of a second render as `-0.22499999999999998s`.
const seconds = (value: number): string => `${Number(value.toFixed(3))}s`;

// Seconds per breath, stretched rather than stopped when the reader asked for less motion.
const reduced = useReducedMotion();
const cycle = computed(() => (reduced.value ? 6.5 : 2.4));
const dur = computed(() => seconds(cycle.value));

// Each petal lags the one before it by a 32nd of the breath, so the light crosses the whole ring in a quarter of it —
// a wave that travels, not eight petals blinking together. A negative `begin` starts a petal already that far in.
const petals = computed(() =>
    Array.from({ length: COUNT }, (_, index) => ({
        rotate: `rotate(${(index * 360) / COUNT})`,
        begin: seconds(-(index * cycle.value) / 32),
    })),
);
</script>

<template>
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width="1em"
        height="1em"
        aria-hidden="true"
        focusable="false"
        shape-rendering="geometricPrecision"
        class="inline-block flex-none align-[-0.125em]"
    >
        <g transform="translate(12 12)">
            <!-- The breath belongs to the whole rosette, so it sits on its own group above the per-petal timing. -->
            <g>
                <animateTransform
                    attributeName="transform"
                    type="scale"
                    values="0.9;1.04;0.9"
                    keyTimes="0;0.5;1"
                    calcMode="spline"
                    keySplines="0.4 0 0.2 1;0.4 0 0.2 1"
                    :dur="dur"
                    repeatCount="indefinite"
                />
                <g v-for="petal in petals" :key="petal.rotate" :transform="petal.rotate">
                    <path :d="PETAL" fill="currentColor" :opacity="DIM">
                        <!-- Lights fast and fades slow: the rise is what the eye catches, the fall is what settles it. -->
                        <animate
                            attributeName="opacity"
                            :values="`${DIM};1;${DIM}`"
                            keyTimes="0;0.45;1"
                            calcMode="spline"
                            keySplines="0.3 0 0.2 1;0.4 0 0.6 1"
                            :dur="dur"
                            :begin="petal.begin"
                            repeatCount="indefinite"
                        />
                    </path>
                </g>
                <!-- The seed never goes out: it is the mark that survives at 11px when the petals are at their dimmest. -->
                <circle r="2" fill="currentColor" opacity="0.5">
                    <animate attributeName="opacity" values="0.35;0.9;0.35" :dur="dur" repeatCount="indefinite" />
                </circle>
            </g>
        </g>
    </svg>
</template>
