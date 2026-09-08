<!-- THE PICTURE ON A RUNG, where the sandbox would live, drawn rather than labelled.

     The rungs wore a 16px glyph beside the title for a release, on the argument that a stacked icon bought a
     row of its own for a decoration. That argument is right about a GLYPH: a bolt is a synonym for the word
     next to it, so the space it takes says nothing twice. It is wrong about a SCENE. This choice is the one
     thing on the page a newcomer cannot look up, where does the machine live, and whose is it, and a cloud
     beside a monitor answers it before the titles are read.

     DRAWN IN THE APP'S OWN HAND, which is the whole of what the first attempt got wrong. That one was chunky:
     2.5px rounded strokes around shapes filled with a wash, which is a sticker-illustration language this
     product does not speak anywhere else. The app's custom icon pack (ui/src/icons) uses hollow shapes,
     an even band, sharp geometry and small solid details. These scenes share that vocabulary at a larger
     scale: 2px on a 132×76 stage, hollow, with one solid accent apiece. The
     bolt is literally `ri:flashlight-line`'s own silhouette; the cloud is the one shape drawn fresh, and the
     comment on it says why a scaled-up `ri:cloud-line` had to be given up.

     OPACITY IS AN SVG ATTRIBUTE HERE, NEVER A UTILITY CLASS. The first version dimmed its fills with
     `opacity-[0.07]`, a value used nowhere else in the app, so the class existed only in this file, a file the
     running dev server had not yet scanned, and the artwork shipped at FULL opacity: a solid white cloud and a
     solid orange monitor. Colour still worked, because `text-link` was already generated elsewhere. A drawing's
     own opacity is a property of the drawing; keeping it in the markup means it cannot depend on whether a
     stylesheet was rebuilt.

     ONE STAGE, TWO SCENES, at one optical weight, so the pair reads as two of one kind, which the old glyph
     set (bolt, desktop) could not, a bolt being an event where the other is an object.

     No text inside the artwork, ever. A label in an illustration cannot be translated, cannot be selected, and
     re-states the title six pixels above it. -->
<script setup lang="ts">
// `kind` picks which scene renders. `selected` is passed rather than computed: the picker owns which rung is
// chosen.
const { kind, selected = false } = defineProps<{ kind: "hosted" | "mine"; selected?: boolean }>();

// Both colours are `color` a theme owns; every shape paints with `currentColor`. `edgeClass` lifts the structure
// by one step when selected; `popClass` is the accent and is never the same colour as the structure.
const edgeClass = (): string => (selected ? `text-muted` : `text-subtle`);
const popClass = (): string => (selected ? `text-link` : `text-muted`);

// Cloud built for the size it renders at (~1.75:1, flat base, three puffs), not `ri:cloud-line` scaled up, which
// reads as a square lump at this size. Same band, arcs only, as the rest of the icon set.
const CLOUD = `M36 66h56a14 14 0 0 0 4-27.5a22 22 0 0 0-40-12a15 15 0 0 0-22 11a15 15 0 0 0 2 28.5z`;
// …and `ri:flashlight-line`'s bolt, solid rather than hollow: at this size the accent is a mark, not an object,
// as the shared icon pack fills its small accent details.
const BOLT = `M13 9h8L11 24v-9H4l9-15z`;
// Stroke band in stage units (2px at render size); scaled groups pre-divide by their own scale.
const BAND = 2;
</script>

<template>
    <!--
        Capped rather than stretched, or past ~132px the drawings read as a banner. `aria-hidden`: the words below say
        what this shows.
    -->
    <svg
        viewBox="0 0 132 76"
        class="mx-auto h-auto w-full max-w-[8.25rem]"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
    >
        <!-- The app's cloud with the app's bolt inside it: whose machine, and how long it takes. -->
        <template v-if="kind === `hosted`">
            <path
                :class="edgeClass()"
                :d="CLOUD"
                transform="translate(-14,-13.6) scale(1.229)"
                stroke="currentColor"
                :stroke-width="BAND / 1.229"
            />
            <path :class="popClass()" :d="BOLT" transform="translate(49.4,29) scale(1.25)" fill="currentColor" />
        </template>

        <!-- A monitor on a stand, with work on the screen. Frame, then bezel at half weight, then the stand. -->
        <template v-else>
            <g :class="edgeClass()" stroke="currentColor" :stroke-width="BAND">
                <rect x="20" y="7" width="92" height="52" rx="3" />
                <rect x="27" y="14" width="78" height="38" rx="1.5" opacity="0.45" />
                <path d="M66 59v8M50 67h32" />
            </g>
            <g :class="popClass()" fill="currentColor">
                <rect x="35" y="23" width="30" height="3" rx="1.5" />
                <rect x="35" y="31" width="44" height="3" rx="1.5" />
                <rect x="35" y="39" width="20" height="3" rx="1.5" />
            </g>
        </template>

    </svg>
</template>
