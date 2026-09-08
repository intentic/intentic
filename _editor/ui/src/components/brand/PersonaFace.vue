<!--
    A persona's cartoon face, generated deterministically from its name via DiceBear's adventurer style. Renaming a persona changes its face;
    upgrading DiceBear's variant lists repaints every face, since nothing is stored.
-->
<script setup lang="ts">
import { Avatar, Style } from "@dicebear/core";
import definition from "@dicebear/styles/adventurer.json";
import { computed } from "vue";
import type { PersonaLike } from "./personaFace.js";

// Defaults to the chat persona rail's card size; every other surface is a row in a list and names its own.
const { persona, size = 56 } = defineProps<{ persona: PersonaLike; size?: number }>();

// The name somebody chose, or the id it was filed under.
const seed = computed<string>(() => persona.label ?? persona.id);

// Curated, not the style's defaults: skin is what a reader recognises a face by across a column.
const SKIN_COLORS = [`#f2d3b1`, `#ecad80`, `#9e5622`, `#763900`, `#c3cde0`, `#b9b4b8`, `#b7c7a5`, `#e3b3c1`] as const;

// Parsed once at module load, shared by every face: the expensive validation is persona-independent.
const style = new Style(definition);

// Reads variant lists straight off the definition (typed to the style's own literals), so a picked part is
// guaranteed valid. Throws on empty, rather than silently drawing everyone the same nose.
type Components = typeof definition.components;
type VariantOf<K extends keyof Components> = keyof Components[K][`variants`] & string;
const variants = <K extends keyof Components>(component: K): readonly VariantOf<K>[] => {
    const names = Object.keys(definition.components[component].variants) as VariantOf<K>[];
    if (names.length === 0) {
        throw new Error(`DiceBear adventurer style has no variants for "${String(component)}"`);
    }
    return names;
};

const EYES = variants(`eyes`);
const EYEBROWS = variants(`eyebrows`);
const MOUTHS = variants(`mouth`);
const HAIRS = variants(`hair`);
const DETAILS = variants(`details`);
const GLASSES = variants(`glasses`);
const EARRINGS = variants(`earrings`);

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
const hex = (byte: number): string => byte.toString(16).padStart(2, `0`);

// Cached per seed: a rail redraws on every keystroke elsewhere, and re-assembling an 8kB SVG each time is wasted
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
        headVariant: `default`,
        // Scaled up so the head fills the circle like other avatars, cropping empty margin without losing hair or chin.
        scale: 1.3,
        skinColor: pick(SKIN_COLORS, bytes[0]!),
        detailsVariant: pick(DETAILS, bytes[1]!),
        detailsProbability: 100,
        eyesVariant: pick(EYES, bytes[2]!),
        eyebrowsVariant: pick(EYEBROWS, bytes[3]!),
        mouthVariant: pick(MOUTHS, bytes[4]!),
        hairVariant: pick(HAIRS, bytes[5]!),
        hairProbability: 100,
        hairColor: `#${hex(bytes[9]!)}${hex(bytes[10]!)}${hex(bytes[11]!)}`,
        glassesVariant: pick(GLASSES, bytes[6]!),
        glassesProbability: 100,
        earringsVariant: pick(EARRINGS, bytes[7]!),
        earringsProbability: 100,
    }).toString();
    cache.set(seed.value, drawn);
    return drawn;
});
</script>

<template>
    <!--
        The name is only a lookup index, never markup, so nothing user-supplied is interpolated into what's rendered. A
        background is needed since the style draws on transparency, or the round silhouette other avatars have would be
        lost.
    -->
    <span
        class="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-content/10"
        :style="{ width: `${size}px`, height: `${size}px` }"
        role="img"
        :aria-label="seed"
        v-html="svg"
    ></span>
</template>
