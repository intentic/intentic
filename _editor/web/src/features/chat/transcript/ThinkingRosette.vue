<!-- The mark beside a live turn's status word: a lotus rosette whose petals light in a wave while the flower breathes. -->
<script setup lang="ts">
import { useCompositedLoops, useReducedMotion } from "@intentic/ui/reduced-motion";
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

// The same flower is drawn from composited layers (the first template below), save under a desktop pointer in a
// developer's build, which keeps SMIL and so leaves DevTools' Styles editor alone. useCompositedLoops says why each.
const composited = useCompositedLoops();

// Seconds per breath, stretched rather than stopped when the reader asked for less motion. Only SMIL reads it here: the
// composited flower takes the same two values from CSS (`--rosette-cycle` below).
const reduced = useReducedMotion(() => !composited.value);
const cycle = computed(() => (reduced.value ? 6.5 : 2.4));
const dur = computed(() => seconds(cycle.value));

// Each petal lags the one before it by a 32nd of the breath, so the light crosses the whole ring in a quarter of it —
// a wave that travels, not eight petals blinking together. A negative `begin` starts a petal already that far in.
const petals = computed(() =>
    Array.from({ length: COUNT }, (_, index) => ({
        rotate: `rotate(${(index * 360) / COUNT})`,
        begin: seconds(-(index * cycle.value) / 32),
        // The composited petal's own turn and lag, the lag as a fraction of the breath CSS resolves.
        style: { transform: `rotate(${(index * 360) / COUNT}deg)`, "--rosette-lag": String(-index / 32) },
    })),
);
</script>

<template>
    <!-- ON THE COMPOSITOR every moving part is its own box: the breath scales the whole flower and each petal fades as its
         own layer, all of it opacity and transform, which the compositor runs without the page's main thread. -->
    <span v-if="composited" class="rosette relative inline-block size-[1em] flex-none align-[-0.125em]" aria-hidden="true">
        <span class="rosette-breath absolute inset-0">
            <svg
                v-for="petal in petals"
                :key="petal.rotate"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                focusable="false"
                shape-rendering="geometricPrecision"
                class="rosette-petal absolute inset-0 size-full"
                :style="petal.style"
            >
                <path :d="PETAL" transform="translate(12 12)" fill="currentColor" />
            </svg>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" focusable="false" class="rosette-seed absolute inset-0 size-full">
                <circle cx="12" cy="12" r="2" fill="currentColor" />
            </svg>
        </span>
    </span>
    <svg
        v-else
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

<style scoped>
/* The composited flower's timing: SMIL's values, keyTimes and keySplines, spelled as keyframes. */
.rosette {
    --rosette-cycle: 2.4s;
}

@media (prefers-reduced-motion: reduce) {
    .rosette {
        --rosette-cycle: 6.5s;
    }
}

.rosette-breath {
    animation: rosette-breath var(--rosette-cycle) cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

.rosette-petal {
    opacity: 0.2;
    animation: rosette-petal var(--rosette-cycle) infinite;
    animation-delay: calc(var(--rosette-cycle) * var(--rosette-lag));
}

.rosette-seed {
    animation: rosette-seed var(--rosette-cycle) linear infinite;
}

@keyframes rosette-breath {
    0%,
    100% {
        transform: scale(0.9);
    }
    50% {
        transform: scale(1.04);
    }
}

/* Lights fast and fades slow, as the SMIL petal does. */
@keyframes rosette-petal {
    0% {
        opacity: 0.2;
        animation-timing-function: cubic-bezier(0.3, 0, 0.2, 1);
    }
    45% {
        opacity: 1;
        animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    100% {
        opacity: 0.2;
    }
}

@keyframes rosette-seed {
    0%,
    100% {
        opacity: 0.35;
    }
    50% {
        opacity: 0.9;
    }
}
</style>
