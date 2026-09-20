<!-- A persona's cartoon face, generated deterministically from its name via DiceBear's clay style. -->
<script setup lang="ts">
import { Avatar, Style } from "@dicebear/core";
import definition from "@dicebear/styles/clay.json";
import { computed } from "vue";
import { FACE_SIZES, type PersonaLike } from "./personaFace.js";

// Defaults to the chat persona rail's card size; every other surface is a row in a list and names its own.
const { persona, size = FACE_SIZES.card } = defineProps<{ persona: PersonaLike; size?: number }>();

// The name somebody chose, or the id it was filed under.
const seed = computed<string>(() => persona.label ?? persona.id);

// Parsed once at module load, shared by every face: the expensive validation is persona-independent.
const style = new Style(definition);

// Reads variant lists straight off the definition (typed to the style's own literals), so a picked part is
// guaranteed valid. Throws on empty, rather than silently drawing everyone the same eyes.
type Components = typeof definition.components;
type VariantOf<K extends keyof Components> = keyof Components[K][`variants`] & string;
const variants = <K extends keyof Components>(component: K): readonly VariantOf<K>[] => {
    const names = Object.keys(definition.components[component].variants) as VariantOf<K>[];
    if (names.length === 0) {
        throw new Error(`DiceBear clay style has no variants for "${String(component)}"`);
    }
    return names;
};

const TOPS = variants(`top`);
const BODIES = variants(`body`);
const PATTERNS = variants(`pattern`);
const EYES = variants(`eyes`);
const MOUTHS = variants(`mouth`);

const BODY_COLORS = definition.colors.body.values;
const ACCENT_COLORS = definition.colors.accent.values;

// Clay draws a full-canvas square by default; DiceBear has no "no background" switch, only a color.
const TRANSPARENT = `00000000`;

// Twelve bytes from a name: FNV-1a hashes it (its avalanche keeps similar names from sharing parts), then a small
// xorshift spins out one byte at a time. Deterministic and dependency-free.
const bytesOf = (text: string): number[] => {
    let hash = 0x81_1c_9d_c5;
    for (const char of text) {
        hash = Math.imul(hash ^ char.charCodeAt(0), 0x01_00_01_93) >>> 0;
    }
    // A zero state would lock xorshift at zero forever: the one seed it cannot leave.
    let state = hash === 0 ? 0x9e_37_79_b9 : hash;
    return Array.from({ length: 12 }, () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state & 0xff;
    });
};

const pick = <T,>(list: readonly T[], byte: number): T => list[byte % list.length]!;

// Cached per seed: a rail redraws on every keystroke elsewhere, and re-assembling a multi-kB SVG each time is wasted
// work.
const cache = new Map<string, string>();

const svg = computed<string>(() => {
    const cached = cache.get(seed.value);
    if (cached !== undefined) {
        return cached;
    }
    const bytes = bytesOf(seed.value);
    const drawn = new Avatar(style, {
        // Keys the SVG's clip-path ids; without it, every face on a rail would share one id and clip through the
        // others.
        seed: seed.value,
        topVariant: pick(TOPS, bytes[1]!),
        topProbability: 100,
        bodyVariant: pick(BODIES, bytes[5]!),
        patternVariant: pick(PATTERNS, bytes[2]!),
        patternProbability: 100,
        eyesVariant: pick(EYES, bytes[3]!),
        mouthVariant: pick(MOUTHS, bytes[4]!),
        animationVariant: `none`,
        bodyColor: pick(BODY_COLORS, bytes[0]!),
        accentColor: pick(ACCENT_COLORS, bytes[6]!),
        backgroundColor: TRANSPARENT,
    }).toString();
    cache.set(seed.value, drawn);
    return drawn;
});
</script>

<template>
    <!-- The name is only a lookup index, never markup, so nothing user-supplied is interpolated into what's rendered. -->
    <span
        class="flex shrink-0 items-center justify-center"
        :style="{ width: `${size}px`, height: `${size}px` }"
        role="img"
        :aria-label="seed"
        v-html="svg"
    ></span>
</template>
