<!-- A PERSONA'S FACE — a cartoon character assembled from its name, so a persona looks like somebody rather
     than like a label.

     THE MECHANISM IS THE REFERENCE IMPLEMENTATION'S, part for part: DiceBear's "adventurer" collection, whose
     schema ships the variant lists (26 pairs of eyes, 45 hairstyles, 30 mouths, and so on), plus a curated set
     of skin tones. A hash is cut into bytes and each byte indexes one list — skin, feature, eyes, eyebrows,
     mouth, hair, glasses, earrings — with three more bytes making the hair colour outright. Every part is
     forced on (glasses, earrings and features are probabilistic by default) because each of them is carrying
     entropy: switching one off would throw away a byte of what makes this face this persona's.
     Read the lists off the SCHEMA rather than copying them here, so the collection is free to grow a hairstyle
     without this file quietly disagreeing about how many there are.

     SEEDED BY THE NAME, which is the one difference from the reference: it derives from a public key, and a
     persona has no key — it has a name somebody chose. So "Shop Support" always draws the same face on every
     machine, with nothing stored and nothing fetched. The cost is that RENAMING A PERSONA GIVES IT A NEW FACE.
     That is the honest reading of a name-derived avatar and it is what was asked for; if a face should instead
     survive a rename, the seed moves to the persona's id and this comment is the place to say so.

     WHY NOT INITIALS, which this drew first: a member's initials are their actual name and you already know
     them, but a persona's are two letters of an invented noun ("SS" over "MA"), so you end up reading the name
     underneath anyway — exactly the work the mark was supposed to save. -->
<script setup lang="ts">
import * as adventurer from "@dicebear/adventurer";
import { createAvatar } from "@dicebear/core";
import { computed } from "vue";

const { seed, size, idle = false } = defineProps<{ seed: string; size: number; idle?: boolean }>();

/* The skin tones, curated rather than taken from the collection's own defaults — this is the one list where
 * the full range is not what you want, because it is the part a reader recognises a face by from across a
 * column and a wide spread of near-identical browns would waste that. Eight, evenly apart. */
const SKIN_COLORS = [`#f2d3b1`, `#ecad80`, `#9e5622`, `#763900`, `#c3cde0`, `#b9b4b8`, `#b7c7a5`, `#e3b3c1`] as const;

/* The collection's own variant lists, read off its schema and handed back at the option's own literal type —
 * so a part this file picks is a part the collection will accept, checked rather than hoped. Absent or empty
 * means the collection changed shape under us, which is worth failing loudly on rather than silently drawing
 * everybody the same nose. */
type Group = NonNullable<adventurer.Options[`eyes`]> extends readonly unknown[] ? keyof adventurer.Options : never;
const variants = <K extends Group>(group: K): NonNullable<adventurer.Options[K]> => {
    const properties = adventurer.schema.properties as Record<string, { default?: string[] } | undefined>;
    const values = properties[group]?.default;
    if (values === undefined || values.length === 0) {
        throw new Error(`DiceBear adventurer schema has no variants for "${String(group)}"`);
    }
    return [...values] as NonNullable<adventurer.Options[K]>;
};

const EYES = variants(`eyes`);
const EYEBROWS = variants(`eyebrows`);
const MOUTHS = variants(`mouth`);
const HAIRS = variants(`hair`);
const FEATURES = variants(`features`);
const GLASSES = variants(`glasses`);
const EARRINGS = variants(`earrings`);

/* TWELVE BYTES FROM A NAME. The reference cuts them off the tail of a hex public key; a name is not hex, so
 * it is hashed (FNV-1a — its avalanche is what keeps "Shop Support" and "Shop Sales" from coming out as
 * siblings) and the hash drives a small xorshift, one byte at a time. Deterministic, dependency-free, and
 * spread well enough that neighbouring names share no parts. */
const bytesOf = (text: string): number[] => {
    let hash = 0x81_1c_9d_c5;
    for (const char of text) {
        hash = Math.imul(hash ^ char.charCodeAt(0), 0x01_00_01_93) >>> 0;
    }
    // A zero state would lock xorshift at zero forever — the one seed it cannot leave.
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

/* Built once per seed and kept: a rail redraws on every keystroke elsewhere in the window, and assembling an
 * 8kB SVG per row per frame is real work to repeat for an answer that cannot have changed. */
const cache = new Map<string, string>();

const svg = computed<string>(() => {
    const cached = cache.get(seed);
    if (cached !== undefined) {
        return cached;
    }
    const bytes = bytesOf(seed);
    const drawn = createAvatar(adventurer, {
        base: [`default`],
        /* The collection draws its head with generous margin, which at rail size left the character floating in
         * the middle of its disc looking like a stamp rather than an avatar. Scaled up until the head fills the
         * circle the way every other avatar in the app does — enough to crop the drawing's empty edges, not so
         * much that hair or chin leaves the frame. */
        scale: 130,
        // DiceBear takes colours bare, without the leading hash the table above writes them with.
        skinColor: [pick(SKIN_COLORS, bytes[0]!).slice(1)],
        features: [pick(FEATURES, bytes[1]!)],
        featuresProbability: 100,
        eyes: [pick(EYES, bytes[2]!)],
        eyebrows: [pick(EYEBROWS, bytes[3]!)],
        mouth: [pick(MOUTHS, bytes[4]!)],
        hair: [pick(HAIRS, bytes[5]!)],
        hairProbability: 100,
        hairColor: [`${hex(bytes[9]!)}${hex(bytes[10]!)}${hex(bytes[11]!)}`],
        glasses: [pick(GLASSES, bytes[6]!)],
        glassesProbability: 100,
        earrings: [pick(EARRINGS, bytes[7]!)],
        earringsProbability: 100,
    }).toString();
    cache.set(seed, drawn);
    return drawn;
});
</script>

<template>
    <!-- The generated markup is the library's own — the name reaches it as a lookup index and never as markup,
         so nothing of the user's is interpolated into what is rendered here.
         A surface behind it because the collection draws on transparency: without one the face floats on
         whatever the card is painted in, and the round silhouette every other avatar in the app has is lost. -->
    <span
        class="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-content/10 transition-opacity"
        :class="idle ? `opacity-50 grayscale` : ``"
        :style="{ width: `${size}px`, height: `${size}px` }"
        role="img"
        :aria-label="seed"
        v-html="svg"
    ></span>
</template>
