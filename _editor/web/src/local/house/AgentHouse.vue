<!-- THE AGENT'S HOUSE: a folder's sandbox drawn as a house going up beside the folder, one part per stage the setup has
     really reached (agentHouse.ts), and the folder's copy carried in through the door. The folder itself never moves. -->
<script setup lang="ts">
import { computed } from "vue";
import { blocksStacked, type HouseStage, reached } from "./agentHouse";

const {
    stage,
    progress = 0,
    paused = false,
    failed = false,
} = defineProps<{
    stage: HouseStage;
    // How far through its stage the build is (0..1), where the stage measures it: the image's download, as blocks.
    progress?: number;
    // Waiting on the reader: everything stands as far as it got, and nothing moves.
    paused?: boolean;
    // The build stopped short of the house: what stands is drawn in the faint tone, beside a warning sign.
    failed?: boolean;
}>();

const at = (part: HouseStage): boolean => reached(stage, part);

// The materials, stacked as the image arrives: bottom row first, so the pile only ever grows upward.
const BLOCKS = [
    { x: 197, y: 92 },
    { x: 205, y: 92 },
    { x: 213, y: 92 },
    { x: 201, y: 85 },
    { x: 209, y: 85 },
    { x: 205, y: 78 },
] as const;
const stacked = computed(() => blocksStacked(stage, progress, BLOCKS.length));

// The folder's copy, a sheet at a time, from the folder's mouth to the door.
const PAPERS = [0, 1, 2] as const;
// Small sparks around the house once it is lived in.
const SPARKS = [
    { x: 103, y: 44, delay: `0s` },
    { x: 199, y: 38, delay: `-1.1s` },
    { x: 214, y: 66, delay: `-2.2s` },
] as const;
const SPARK = `M0-3.4L.9-.9L3.4 0L.9.9L0 3.4L-.9.9L-3.4 0L-.9-.9Z`;

// One petal pair at a time, as the brand's mark draws them (AppBrand.vue), sized for the gable.
const LOTUS_SIDE = `M8.4 25.6c-3.2 0-5.6-1-7.2-3 3.6-1.2 6.6-.7 9 1.4z`;
const LOTUS_SIDE_RIGHT = `M23.6 25.6c3.2 0 5.6-1 7.2-3-3.6-1.2-6.6-.7-9 1.4z`;
const LOTUS_PETAL = `M16 9.5c2.1 3 3.2 5.7 3.2 8.1 0 2.2-1.1 4.1-3.2 5.6-2.1-1.5-3.2-3.4-3.2-5.6 0-2.4 1.1-5.1 3.2-8.1z`;
const LOTUS_INNER = `M16 6.4c2.4 3.4 3.6 6.4 3.6 9.1 0 2.5-1.2 4.6-3.6 6.3-2.4-1.7-3.6-3.8-3.6-6.3 0-2.7 1.2-5.7 3.6-9.1z`;
const LOTUS_CENTRE = `M16 3.4c2.8 4 4.2 7.5 4.2 10.6 0 2.9-1.4 5.4-4.2 7.3-2.8-1.9-4.2-4.4-4.2-7.3 0-3.1 1.4-6.6 4.2-10.6z`;
</script>

<template>
    <!-- Framed on what is drawn, from the smoke's highest puff to the ground, so the scene fills whatever holds it. -->
    <svg
        viewBox="0 14 240 90"
        class="agent-house"
        :data-stage="stage"
        :data-paused="paused || failed"
        :data-failed="failed"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
    >
        <!-- The ground everything stands on, and a few tufts so it reads as ground rather than a rule. -->
        <g class="text-line-strong" stroke="currentColor" stroke-width="1.5">
            <path d="M8 100H232" />
            <path d="M70 100l-1.5-3M74 100l1-3.5M92 100l-1-2.5M226 100l1.5-3" opacity="0.7" />
        </g>

        <!-- The reader's folder, where it was and as it was: copy-first, so it never takes part in the building. Its back
             with the tab, its sheets showing over the front's lip, and the front, leaning out a little. -->
        <g class="house-structure" stroke="currentColor" stroke-width="1.5">
            <path d="M17 99V71a2 2 0 0 1 2-2h9.5l3.5 3.5h17.5a2 2 0 0 1 2 2v6" fill="currentColor" fill-opacity="0.05" />
        </g>
        <g class="text-link" stroke="currentColor" stroke-width="1.2">
            <path d="M23 80.5v-5h12l3 3v2" fill="currentColor" fill-opacity="0.14" />
        </g>
        <g class="house-structure" stroke="currentColor" stroke-width="1.5">
            <path d="M17 99l2.4-18.5h35l-2.4 18.5z" fill="currentColor" fill-opacity="0.09" />
        </g>

        <!-- The plans, dashed, wherever nothing real stands yet: the walls' and the roof's own outline until each is up. -->
        <g class="house-blueprint text-subtle" stroke="currentColor" stroke-width="1" stroke-dasharray="2.5 3">
            <rect class="house-part" :data-on="!at(`walls`)" x="118" y="60" width="64" height="35" />
            <path class="house-part" :data-on="!at(`roof`)" d="M110 62L150 34L190 62" />
            <path class="house-part" :data-on="!at(`walls`)" d="M143 95V83a7 7 0 0 1 14 0v12" />
        </g>
        <!-- The surveyor's stakes, while the plans are all there is. -->
        <g class="house-part house-stakes text-subtle" :data-on="stage === `plan`" stroke="currentColor" stroke-width="1.2">
            <path d="M112 100V85M188 100V85" />
            <path class="house-flag" d="M112 85.5l7 2.5-7 2.5" fill="currentColor" style="transform-origin: 112px 85.5px" />
            <path class="house-flag" d="M188 85.5l7 2.5-7 2.5" fill="currentColor" style="transform-origin: 188px 85.5px; animation-delay: -0.6s" />
        </g>

        <!-- The foundation, poured as the materials arrive. -->
        <rect
            class="house-part house-foundation house-structure"
            :data-on="at(`ground`)"
            x="112"
            y="95"
            width="76"
            height="5"
            rx="1"
            stroke="currentColor"
            stroke-width="1.5"
            fill="currentColor"
            fill-opacity="0.12"
        />
        <!-- The materials: one block per share of the image downloaded, stacked beside the site, gone into the walls. -->
        <g class="house-part text-link" :data-on="stage === `ground`" stroke="currentColor" stroke-width="1.2">
            <rect
                v-for="(block, index) in BLOCKS"
                :key="index"
                class="house-part house-block"
                :data-on="index < stacked"
                :x="block.x"
                :y="block.y"
                width="7"
                height="7"
                rx="1"
                fill="currentColor"
                fill-opacity="0.18"
            />
        </g>

        <!-- The walls, rising from the foundation: the container started. Window frames and the door's opening with them. -->
        <g class="house-part house-walls house-structure" :data-on="at(`walls`)" stroke="currentColor" stroke-width="1.5">
            <rect x="118" y="60" width="64" height="35" fill="currentColor" fill-opacity="0.05" />
            <path d="M124 89h6M136 89h5M161 89h7M174 89h4M121 66h4" opacity="0.35" />
            <rect x="124" y="68" width="14" height="12" rx="1" />
            <rect x="162" y="68" width="14" height="12" rx="1" />
            <path d="M143 95V83a7 7 0 0 1 14 0v12" />
        </g>

        <!-- The roof and its chimney: the daemon coming up inside. -->
        <g class="house-part house-roof house-structure" :data-on="at(`roof`)" stroke="currentColor" stroke-width="1.5">
            <path d="M165 44.5V38h8v12.1" />
            <path d="M110 62L150 34L190 62" fill="currentColor" fill-opacity="0.08" />
        </g>

        <!-- The lights: the sandbox answers, and the lotus over the door says whose house it is. -->
        <g class="house-part house-lights" :data-on="at(`lit`)">
            <g class="text-primary-500" fill="currentColor">
                <circle class="house-halo" cx="131" cy="74" r="13" opacity="0.14" />
                <circle class="house-halo" cx="169" cy="74" r="13" opacity="0.14" style="animation-delay: -1.7s" />
                <rect class="house-window" x="125" y="69" width="12" height="10" rx="0.5" opacity="0.85" />
                <rect class="house-window" x="163" y="69" width="12" height="10" rx="0.5" opacity="0.85" style="animation-delay: -2.3s" />
            </g>
            <g class="house-structure" stroke="currentColor" stroke-width="1.2">
                <path d="M131 68v12M124 74h14M169 68v12M162 74h14" />
            </g>
            <g class="house-lotus text-link" fill="currentColor" transform="translate(142.6 42.4) scale(0.46)">
                <path :d="LOTUS_SIDE" opacity=".42" />
                <path :d="LOTUS_SIDE_RIGHT" opacity=".42" />
                <path :d="LOTUS_PETAL" transform="rotate(-74 16 22.6)" opacity=".55" />
                <path :d="LOTUS_PETAL" transform="rotate(74 16 22.6)" opacity=".55" />
                <path :d="LOTUS_INNER" transform="rotate(-39 16 21.7)" opacity=".78" />
                <path :d="LOTUS_INNER" transform="rotate(39 16 21.7)" opacity=".78" />
                <path :d="LOTUS_CENTRE" />
            </g>
        </g>

        <!-- The folder's copy, carried in: each sheet flies one arc from the folder to the door, over and over until it is in. -->
        <g v-if="stage === `moving`" class="text-link">
            <g v-for="paper in PAPERS" :key="paper" class="house-paper-x" :style="{ animationDelay: `${paper * -0.62}s` }">
                <g class="house-paper-y" :style="{ animationDelay: `${paper * -0.62}s` }">
                    <path
                        d="M30 66h5.5l2.5 2.5V76h-8z"
                        stroke="currentColor"
                        stroke-width="1.1"
                        fill="currentColor"
                        fill-opacity="0.2"
                    />
                </g>
            </g>
        </g>

        <!-- The door: shut until the house is lived in, then open, with the light coming out of it. -->
        <g class="house-part" :data-on="at(`walls`)">
            <path class="text-primary-500" d="M144 95V83a6 6 0 0 1 12 0v12z" fill="currentColor" :opacity="at(`home`) ? 0.55 : 0" />
            <path
                class="house-door house-structure"
                :data-open="at(`home`)"
                d="M144 95V83a6 6 0 0 1 12 0v12z"
                stroke="currentColor"
                stroke-width="1.2"
                fill="currentColor"
                fill-opacity="0.16"
                style="transform-origin: 144px 95px"
            />
        </g>

        <!-- Lived in: someone at the window, smoke from the chimney, a spark or two about the place. -->
        <g class="house-part" :data-on="at(`home`)">
            <g class="house-eyes text-content" fill="currentColor" style="transform-origin: 131px 74px">
                <circle cx="128.6" cy="74" r="1.15" />
                <circle cx="133.4" cy="74" r="1.15" />
            </g>
            <g class="text-subtle" fill="currentColor">
                <circle class="house-smoke" cx="169" cy="35" r="2.2" />
                <circle class="house-smoke" cx="169" cy="35" r="2.6" style="animation-delay: -1s" />
                <circle class="house-smoke" cx="169" cy="35" r="2" style="animation-delay: -2s" />
            </g>
            <!-- Placed by the group, twinkled by the path: a CSS transform on the path would replace its placement. -->
            <g class="text-link" fill="currentColor">
                <g v-for="spark in SPARKS" :key="spark.x" :transform="`translate(${spark.x} ${spark.y})`">
                    <path class="house-spark" :d="SPARK" :style="{ animationDelay: spark.delay }" />
                </g>
            </g>
        </g>

        <!-- A build that stopped: a sign on the site, where the next attempt picks up. -->
        <g v-if="failed" class="text-warning" stroke="currentColor" stroke-width="1.4">
            <path d="M212 100V84" />
            <path d="M212 70l8 13h-16z" fill="currentColor" fill-opacity="0.15" />
            <path d="M212 75v3.5M212 80.6v.1" />
        </g>
    </svg>
</template>

<style scoped>
.agent-house {
    display: block;
    overflow: visible;
}

/* The structure's tone: lifted while the house goes up, faint once a build has stopped. */
.house-structure {
    color: var(--color-muted);
    transition: color var(--motion-grow) var(--ease-smooth);
}
.agent-house[data-failed="true"] .house-structure {
    color: var(--color-subtle);
}

/* Every part arrives as the stage that builds it is reached, and leaves the same way (the plans, once built over). */
.house-part {
    transition:
        opacity 700ms var(--ease-smooth),
        transform 900ms var(--ease-smooth);
}
.house-part[data-on="false"] {
    opacity: 0;
}

/* The foundation is poured outward from the middle; the walls rise from it; the roof is set down on them. */
.house-foundation {
    transform-box: view-box;
    transform-origin: 150px 100px;
}
.house-foundation[data-on="false"] {
    transform: scaleX(0.2);
}
.house-walls {
    transform-box: view-box;
    transform-origin: 150px 95px;
}
.house-walls[data-on="false"] {
    transform: scaleY(0.04);
}
.house-roof[data-on="false"] {
    transform: translateY(-14px);
}
.house-block[data-on="false"] {
    transform: translateY(-16px);
}
.house-lotus {
    transition: opacity 900ms var(--ease-smooth);
}
.house-door {
    transform-box: view-box;
    transition: transform 900ms var(--ease-smooth);
}
.house-door[data-open="true"] {
    transform: scaleX(0.2);
}

/* LOOPS, each saying something is going on: the plans waiting on the stakes, the light inside, the copy going in, a
   house that is lived in. All transform and opacity, so the compositor runs them. Stopped where nothing is going on. */
.house-flag {
    transform-box: view-box;
    animation: house-flag 2.4s ease-in-out infinite;
}
.house-blueprint {
    animation: house-breathe 2.8s ease-in-out infinite;
}
.house-window {
    animation: house-flicker 4.6s ease-in-out infinite;
}
.house-halo {
    animation: house-glow 4.6s ease-in-out infinite;
}
.house-paper-x {
    animation: house-paper-x 1.86s linear infinite;
}
.house-paper-y {
    animation: house-paper-y 1.86s infinite;
}
.house-smoke {
    transform-box: fill-box;
    transform-origin: center;
    animation: house-smoke 3s ease-out infinite;
}
.house-eyes {
    transform-box: view-box;
    animation: house-blink 5s ease-in-out infinite;
}
.house-spark {
    transform-box: fill-box;
    transform-origin: center;
    animation: house-spark 3.3s ease-in-out infinite;
}

.agent-house[data-paused="true"] :is(.house-flag, .house-blueprint, .house-window, .house-halo, .house-paper-x, .house-paper-y, .house-smoke, .house-eyes, .house-spark) {
    animation-play-state: paused;
}

/* Less motion asked for: what says work is going on slows down, and what only decorates stops. */
:root[data-motion="reduced"] .house-blueprint {
    animation-duration: 8s;
}
:root[data-motion="reduced"] :is(.house-paper-x, .house-paper-y) {
    animation-duration: 5.6s;
}
:root[data-motion="reduced"] :is(.house-flag, .house-window, .house-halo, .house-smoke, .house-eyes, .house-spark) {
    animation: none;
}

@keyframes house-flag {
    0%,
    100% {
        transform: rotate(-6deg);
    }
    50% {
        transform: rotate(8deg);
    }
}

@keyframes house-breathe {
    0%,
    100% {
        opacity: 0.45;
    }
    50% {
        opacity: 1;
    }
}

@keyframes house-glow {
    0%,
    100% {
        opacity: 0.1;
    }
    40% {
        opacity: 0.2;
    }
}

@keyframes house-flicker {
    0%,
    100% {
        opacity: 0.8;
    }
    40% {
        opacity: 1;
    }
    55% {
        opacity: 0.88;
    }
}

/* A sheet's flight is two motions at once, as a thrown thing's is: steady across, and up then down. Across fades it in at
   the folder and out at the door. */
@keyframes house-paper-x {
    0% {
        transform: translateX(0);
        opacity: 0;
    }
    12% {
        opacity: 1;
    }
    84% {
        opacity: 1;
    }
    100% {
        transform: translateX(114px);
        opacity: 0;
    }
}

@keyframes house-paper-y {
    0% {
        transform: translateY(0);
        animation-timing-function: cubic-bezier(0.2, 0.7, 0.4, 1);
    }
    44% {
        transform: translateY(-34px);
        animation-timing-function: cubic-bezier(0.6, 0, 0.8, 0.3);
    }
    100% {
        transform: translateY(14px);
    }
}

@keyframes house-smoke {
    0% {
        transform: translate(0, 0) scale(0.6);
        opacity: 0;
    }
    20% {
        opacity: 0.7;
    }
    100% {
        transform: translate(5px, -16px) scale(1.5);
        opacity: 0;
    }
}

@keyframes house-blink {
    0%,
    92%,
    100% {
        transform: scaleY(1);
    }
    96% {
        transform: scaleY(0.1);
    }
}

@keyframes house-spark {
    0%,
    100% {
        transform: scale(0.4);
        opacity: 0;
    }
    50% {
        transform: scale(1);
        opacity: 1;
    }
}
</style>
