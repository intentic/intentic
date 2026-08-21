<!-- A PERSONA'S FACE: a cartoon character assembled from its name, so a persona looks like somebody rather
     than like a label.

     THE MECHANISM IS THE REFERENCE IMPLEMENTATION'S, part for part: DiceBear's "adventurer" style, whose
     definition ships the variant lists (26 pairs of eyes, 45 hairstyles, 30 mouths, and so on), plus a curated
     set of skin tones. A hash is cut into bytes and each byte indexes one list: skin, detail, eyes, eyebrows,
     mouth, hair, glasses, earrings: with three more bytes making the hair colour outright. Every part is
     forced on (glasses, earrings and details are probabilistic by default) because each of them is carrying
     entropy: switching one off would throw away a byte of what makes this face this persona's.
     Read the lists off the STYLE DEFINITION rather than copying them here, so the style is free to grow a
     hairstyle without this file quietly disagreeing about how many there are, and, because the definition is
     imported as data, the variant names this file picks are checked against it at compile time.

     SEEDED BY THE NAME, which is the one difference from the reference: it derives from a public key, and a
     persona has no key: it has a name somebody chose. So "Shop Support" always draws the same face on every
     machine, with nothing stored and nothing fetched. The cost is that RENAMING A PERSONA GIVES IT A NEW FACE.
     That is the honest reading of a name-derived avatar and it is what was asked for; if a face should instead
     survive a rename, the seed moves to the persona's id and this comment is the place to say so.

     THE SAME COST IS PAID WHEN THE STYLE REORDERS ITS VARIANTS, which is not obvious and bit once already: a
     byte indexes a LIST, so a definition that ships the same 26 eyes in a different order repaints everybody
     even though nothing about this file or the persona changed. Upgrading DiceBear from v9 to v10 did exactly
     that: every list kept its members and its length, so faces stayed as varied as before, but each persona
     landed on a different combination. Nothing is stored, so this is repainting and not data loss, and the only
     way to prevent it would be to freeze a copy of the old ordering here, which is the very hardcoding the note
     above refuses. Expect a style upgrade to change every face, and say so when one ships.

     WHY NOT INITIALS, which this drew first: a member's initials are their actual name and you already know
     them, but a persona's are two letters of an invented noun ("SS" over "MA"), so you end up reading the name
     underneath anyway: exactly the work the mark was supposed to save.

     IT LIVES IN THE DESIGN SYSTEM, and it did not start here. It sat in the web app beside the pages that draw
     persona LISTS, which was fine until the two surfaces where you CHOOSE a persona: an automation's "Runs as"
     and a workflow step's "Acts as": turned out to be extensions, and an extension can import nothing out of
     the app. Both of them therefore drew a persona as a line of text, on the one kind of screen where you are
     picking by sight. That is the same journey <BrandMark> and <SplitView> made, for the same reason: this is
     identity, and identity that changes drawing depending on which surface you meet it on is not identity.

     IT TAKES THE PERSONA, NOT A SEED, and that is load-bearing rather than tidy. Every caller used to write
     `persona.label ?? persona.id` at the call site, which is a RULE: "a card's face is made of the name you
     gave it, falling back to its id": copied into four templates that were each free to disagree, and the
     whole point of a derived avatar is that one persona is one character everywhere. The rule lives here now,
     written once, and a surface can only ask for a persona's face; it cannot describe one.

     THERE IS NO DIMMED VARIANT. This drew a persona whose accounts were all signed out (or that had none yet)
     in greyscale on the personas page and in the composer's picker, but at full colour in the chat rail, so
     the same card wore two different faces depending on where you met it, and the commonest case of all, a
     persona somebody made a minute ago, met you as a grey smudge on the very page that exists to show it off.
     A face is identity and identity does not have a disabled state: whether a card can post is a fact ABOUT it,
     and where it is worth saying at all it is said in words ("- not signed in yet", the Not signed in badge,
     the dimmed account marks beside it). Holding no accounts is not one of those facts: that is an ordinary
     card, and no surface remarks on it. -->
<script setup lang="ts">
import { Avatar, Style } from "@dicebear/core";
import definition from "@dicebear/styles/adventurer.json";
import { computed } from "vue";
import type { PersonaLike } from "./personaFace.js";

/* THE SIZE DEFAULTS TO THE LIST SIZE, so the two surfaces that show a persona AS A PERSON: its own page and
 * the chat's persona rail: both say `<PersonaFace :persona />` and cannot drift apart the way a 32 here and a
 * 56 there did. The smaller numbers are the ones worth writing down: a picker row and a folder card are lists
 * of something else that happen to name a persona. */
const { persona, size = 56 } = defineProps<{ persona: PersonaLike; size?: number }>();

// The name somebody chose, or the id it was filed under: see the note above for why this lives here and not
// at four call sites.
const seed = computed<string>(() => persona.label ?? persona.id);

/* The skin tones, curated rather than taken from the style's own defaults: this is the one list where
 * the full range is not what you want, because it is the part a reader recognises a face by from across a
 * column and a wide spread of near-identical browns would waste that. Eight, evenly apart. */
const SKIN_COLORS = [`#f2d3b1`, `#ecad80`, `#9e5622`, `#763900`, `#c3cde0`, `#b9b4b8`, `#b7c7a5`, `#e3b3c1`] as const;

/* Parsed and schema-validated once, at module load, and shared by every face on the screen: the validation is
 * the expensive half of drawing an avatar and none of it depends on which persona is being drawn. */
const style = new Style(definition);

/* The style's own variant lists, read off the definition and handed back at the option's own literal type, so
 * a part this file picks is a part the style will accept, checked rather than hoped. Empty means the style
 * changed shape under us, which is worth failing loudly on rather than silently drawing everybody the same
 * nose. */
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

/* TWELVE BYTES FROM A NAME. The reference cuts them off the tail of a hex public key; a name is not hex, so
 * it is hashed (FNV-1a: its avalanche is what keeps "Shop Support" and "Shop Sales" from coming out as
 * siblings) and the hash drives a small xorshift, one byte at a time. Deterministic, dependency-free, and
 * spread well enough that neighbouring names share no parts. */
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

/* Built once per seed and kept: a rail redraws on every keystroke elsewhere in the window, and assembling an
 * 8kB SVG per row per frame is real work to repeat for an answer that cannot have changed. */
const cache = new Map<string, string>();

const svg = computed<string>(() => {
    const cached = cache.get(seed.value);
    if (cached !== undefined) {
        return cached;
    }
    const bytes = bytesOf(seed.value);
    const drawn = new Avatar(style, {
        /* Not what picks the parts: the bytes below do all of that, but what makes the ids inside the markup
         * this persona's own. Several faces share one document and each drawing declares a clip path; without a
         * seed to key them by they would all declare the SAME id and the browser would resolve every reference
         * to whichever landed first, cropping half the rail through one persona's outline. */
        seed: seed.value,
        headVariant: `default`,
        /* The style draws its head with generous margin, which at rail size left the character floating in the
         * middle of its disc looking like a stamp rather than an avatar. Scaled up until the head fills the
         * circle the way every other avatar in the app does: enough to crop the drawing's empty edges, not so
         * much that hair or chin leaves the frame. */
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
    <!-- The generated markup is the library's own: the name reaches it as a lookup index and never as markup,
         so nothing of the user's is interpolated into what is rendered here.
         A surface behind it because the style draws on transparency: without one the face floats on
         whatever the card is painted in, and the round silhouette every other avatar in the app has is lost. -->
    <span
        class="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-content/10"
        :style="{ width: `${size}px`, height: `${size}px` }"
        role="img"
        :aria-label="seed"
        v-html="svg"
    ></span>
</template>
