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
     underneath anyway — exactly the work the mark was supposed to save.

     IT TAKES THE PERSONA, NOT A SEED, and that is load-bearing rather than tidy. Every caller used to write
     `persona.label ?? persona.id` at the call site, which is a RULE — "a card's face is made of the name you
     gave it, falling back to its id" — copied into four templates that were each free to disagree, and the
     whole point of a derived avatar is that one persona is one character everywhere. The rule lives here now,
     written once, and a surface can only ask for a persona's face; it cannot describe one.

     THERE IS NO DIMMED VARIANT. This drew a persona whose accounts were all signed out (or that had none yet)
     in greyscale on the personas page and in the composer's picker, but at full colour in the chat rail — so
     the same card wore two different faces depending on where you met it, and the commonest case of all, a
     persona somebody made a minute ago, met you as a grey smudge on the very page that exists to show it off.
     A face is identity and identity does not have a disabled state: whether a card can post is a fact ABOUT it,
     and where it is worth saying at all it is said in words ("— not signed in yet", the Not signed in badge,
     the dimmed account marks beside it). Holding no accounts is not one of those facts — that is an ordinary
     card, and no surface remarks on it. -->
<script setup lang="ts">
import * as adventurer from "@dicebear/adventurer";
import { createAvatar } from "@dicebear/core";
import { computed } from "vue";

/* Everything this needs of a persona, and nothing more — so the folder panel's cards, the rail's rows and the
 * page's own list all satisfy it without any of them having to hold a whole Persona to draw one. */
interface PersonaLike {
    readonly id: string;
    readonly label?: string;
}

/* THE SIZE DEFAULTS TO THE LIST SIZE, so the two surfaces that show a persona AS A PERSON — its own page and
 * the chat's persona rail — both say `<PersonaFace :persona />` and cannot drift apart the way a 32 here and a
 * 44 there did. The smaller numbers are the ones worth writing down: a picker row and a folder card are lists
 * of something else that happen to name a persona. */
const { persona, size = 44 } = defineProps<{ persona: PersonaLike; size?: number }>();

// The name somebody chose, or the id it was filed under — see the note above for why this lives here and not
// at four call sites.
const seed = computed<string>(() => persona.label ?? persona.id);

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
    const cached = cache.get(seed.value);
    if (cached !== undefined) {
        return cached;
    }
    const bytes = bytesOf(seed.value);
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
    cache.set(seed.value, drawn);
    return drawn;
});
</script>

<template>
    <!-- The generated markup is the library's own — the name reaches it as a lookup index and never as markup,
         so nothing of the user's is interpolated into what is rendered here.
         A surface behind it because the collection draws on transparency: without one the face floats on
         whatever the card is painted in, and the round silhouette every other avatar in the app has is lost. -->
    <span
        class="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-content/10"
        :style="{ width: `${size}px`, height: `${size}px` }"
        role="img"
        :aria-label="seed"
        v-html="svg"
    ></span>
</template>
