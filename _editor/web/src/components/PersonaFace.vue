<!-- A PERSONA'S FACE — a mark generated from its id, so every persona looks like somebody rather than like a
     label. Deterministic and local: the same card draws the same face on every machine, every launch, with no
     stored image, no upload and no request to anybody.

     WHY NOT INITIALS, which is what this drew first and what <Avatar> draws for people. A member's initials
     mean something — they are that person's actual name, and you already know it. A persona is a role somebody
     invented five minutes ago ("Shop Support", "Maintainer"), so its initials are two letters of a noun, and a
     column of them reads as a column of labels: you end up reading the name underneath anyway, which is exactly
     the work the mark was supposed to save. Art is findable at a glance in a way that "SS" over "MA" is not.

     WHY NOT GRAVATAR, which is where the reference implementation gets its faces. It hashes an identity and
     fetches a picture from a third party — a request per row, a name (however hashed) handed to somebody else,
     a broken image when the sandbox is offline, and nothing at all for a persona, which has no email to hash.
     The generated-art half of that idea is the good half, so this keeps it and drops the network.

     THE SHAPE. A disc in the persona's own hue (personaHue, the same colour it wears everywhere else), with
     two translucent blobs laid over it at angles and offsets taken from the same hash. Both blobs sit in
     neighbouring hues rather than free ones, so a face is always one recognisable colour from across the
     column while still being individual up close — the thing a hue alone cannot do once two personas land near
     each other on the wheel. Everything is clipped to the disc, so the mark keeps the round silhouette every
     other avatar in the app has. -->
<script setup lang="ts">
import { computed } from "vue";
import { personaHue } from "../composables/identityHue";

const { seed, size, idle = false } = defineProps<{ seed: string; size: number; idle?: boolean }>();

/* The one hash, spread across the handful of numbers a face needs. FNV-1a, like personaHue's — its avalanche
 * is what keeps two personas named a word apart from coming out as near-twins, which a ×31 hash's low bits
 * would not. Each trait reads a DIFFERENT slice of the 32 bits rather than re-deriving from the same modulus,
 * so rotation and offset don't move together. */
const bits = computed<number>(() => {
    let hash = 0x81_1c_9d_c5;
    for (const char of seed) {
        hash = Math.imul(hash ^ char.charCodeAt(0), 0x01_00_01_93) >>> 0;
    }
    return hash;
});

// A trait in [0, span), read off `count` bits starting at `at`.
const trait = (at: number, count: number, span: number): number => ((bits.value >>> at) % (1 << count)) % span;

const hue = computed(() => personaHue(seed));
const face = computed(() => ({
    // The two blobs, each with its own hue offset, position, size and tilt.
    first: {
        fill: `hsl(${(hue.value + 40 + trait(3, 5, 30)) % 360} 70% 62%)`,
        cx: 10 + trait(8, 4, 12),
        cy: 8 + trait(12, 4, 12),
        r: 11 + trait(16, 3, 6),
        rotate: trait(19, 6, 360),
    },
    second: {
        fill: `hsl(${(hue.value + 330 - trait(6, 5, 30)) % 360} 65% 38%)`,
        cx: 14 + trait(22, 4, 12),
        cy: 18 + trait(26, 4, 12),
        r: 9 + trait(29, 3, 7),
        rotate: trait(9, 6, 360),
    },
}));

// One clip per instance: two faces on screen must not share an id, or the second silently re-uses the first's.
const clipId = computed(() => `persona-face-${seed.replaceAll(/[^a-z0-9]/giu, `-`)}`);
</script>

<template>
    <svg
        :width="size"
        :height="size"
        viewBox="0 0 36 36"
        role="img"
        :aria-label="seed"
        class="shrink-0 rounded-full transition-opacity"
        :class="idle ? `opacity-50 grayscale` : ``"
    >
        <defs>
            <clipPath :id="clipId"><circle cx="18" cy="18" r="18" /></clipPath>
        </defs>
        <g :clip-path="`url(#${clipId})`">
            <circle cx="18" cy="18" r="18" :fill="`hsl(${hue} 55% 42%)`" />
            <ellipse
                :cx="face.first.cx"
                :cy="face.first.cy"
                :rx="face.first.r"
                :ry="face.first.r * 0.72"
                :fill="face.first.fill"
                opacity="0.85"
                :transform="`rotate(${face.first.rotate} ${face.first.cx} ${face.first.cy})`"
            />
            <ellipse
                :cx="face.second.cx"
                :cy="face.second.cy"
                :rx="face.second.r"
                :ry="face.second.r * 0.85"
                :fill="face.second.fill"
                opacity="0.75"
                :transform="`rotate(${face.second.rotate} ${face.second.cx} ${face.second.cy})`"
            />
        </g>
    </svg>
</template>
