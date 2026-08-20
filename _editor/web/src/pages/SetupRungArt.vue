<!-- THE PICTURE ON A RUNG — where the sandbox would live, drawn rather than labelled.

     The rungs wore a 16px glyph beside the title for a release, on the argument that a stacked icon bought a
     row of its own for a decoration. That argument is right about a GLYPH: a bolt is a synonym for the word
     next to it, so the space it takes says nothing twice. It is wrong about a SCENE. This choice is the one
     thing on the page a newcomer cannot look up — where does the machine live, and whose is it — and a cloud,
     a monitor and a rack answer it before the titles are read.

     DRAWN IN THE APP'S OWN HAND, which is the whole of what the first attempt got wrong. That one was chunky:
     2.5px rounded strokes around shapes filled with a wash, which is a sticker-illustration language this
     product does not speak anywhere else. Every icon in the app is Remix's LINE set (ui/src/icons) — a 24 grid,
     hollow shapes, a thin even band, sharp geometry, small solid details. So these are the same drawings, in
     the same band, at five times the size: 2px on a 132×76 stage, hollow, with one solid accent apiece. The
     bolt is literally `ri:flashlight-line`'s own silhouette; the cloud is the one shape drawn fresh, and the
     comment on it says why a scaled-up `ri:cloud-line` had to be given up.

     OPACITY IS AN SVG ATTRIBUTE HERE, NEVER A UTILITY CLASS. The first version dimmed its fills with
     `opacity-[0.07]`, a value used nowhere else in the app — so the class existed only in this file, a file the
     running dev server had not yet scanned, and the artwork shipped at FULL opacity: a solid white cloud and a
     solid orange monitor. Colour still worked, because `text-link` was already generated elsewhere. A drawing's
     own opacity is a property of the drawing; keeping it in the markup means it cannot depend on whether a
     stylesheet was rebuilt.

     ONE STAGE, THREE SCENES, at one optical weight, so the row reads as three of one kind — which the old glyph
     set (bolt, desktop, cloud) could not, a bolt being an event where the other two are objects.

     No text inside the artwork, ever. A label in an illustration cannot be translated, cannot be selected, and
     re-states the title six pixels above it. -->
<script setup lang="ts">
/* `kind` is the rung's own value, so the drawing cannot drift from the option it belongs to. `selected` is
 * passed rather than computed here: the picker owns which rung is chosen, and a child that re-derived it would
 * be a second copy of that state. */
const { kind, selected = false } = defineProps<{ kind: "hosted" | "mine" | "cloud"; selected?: boolean }>();

/* Two colours, and both are `color` a theme owns — every shape below paints with `currentColor`.
 *
 * The STRUCTURE lifts by one step when chosen rather than turning orange: a whole drawing in the accent is
 * what the first attempt did, and a solid orange monitor reads as a warning, not a choice. The card's border
 * and fill already say which rung is selected; the artwork only has to agree, quietly.
 * The ACCENT is the one detail that does turn — and it is never the same colour as the structure, in either
 * state, or the focal point of each drawing would vanish into its outline. */
const edgeClass = (): string => (selected ? `text-muted` : `text-subtle`);
const popClass = (): string => (selected ? `text-link` : `text-muted`);

/* THE CLOUD IS DRAWN WIDE, and that is the one place these scenes part from the icon set on purpose.
 *
 * It started as `ri:cloud-line`'s own outer contour, scaled up — the safest possible match. But that shape is
 * 22×19 on its grid, which is very nearly SQUARE, and at 16px nobody reads a bounding box. At 100px they do:
 * beside a monitor and a rack that are both plainly landscape, a square blob stops reading as a cloud and
 * starts reading as a lump. So this is a cloud built for the size it is shown at — flat base, three puffs,
 * roughly 1.75:1 — while everything that makes it belong here is unchanged: one uniform band, arcs only, the
 * same geometry the line set is drawn with.
 *
 * Every arc's chord is kept inside its own diameter; an arc asked to span further than it can silently swells
 * its radius, which is how a hand-written cloud ends up with one bump fatter than its neighbours. */
const CLOUD = `M36 66h56a14 14 0 0 0 4-27.5a22 22 0 0 0-40-12a15 15 0 0 0-22 11a15 15 0 0 0 2 28.5z`;
// …and `ri:flashlight-line`'s bolt, solid rather than hollow: at this size the accent is a mark, not an object,
// and Remix fills its own small details (the LEDs on `ri:server-line`) exactly this way.
const BOLT = `M13 9h8L11 24v-9H4l9-15z`;
// The band, in stage units — 2px at the size this renders. Both scaled groups pre-divide by their own scale,
// since a transform scales the stroke with everything else.
const BAND = 2;
</script>

<template>
    <!-- Capped rather than stretched: past ~132px the drawings stop reading as objects on a card and start
         reading as a banner. `aria-hidden`, because everything this says is said in words underneath it. -->
    <svg
        viewBox="0 0 132 76"
        class="mx-auto h-auto w-full max-w-[8.25rem]"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
    >
        <!-- OUR MACHINE, ALREADY WARM: the app's cloud with the app's bolt inside it. The cloud is whose the
             machine is, the bolt is how long it takes — the two facts the title and the note carry between
             them, said in one picture. -->
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

        <!-- THE READER'S OWN: a monitor on a stand, with work on the screen. The one scene here that is a thing
             somebody is looking at right now, which is the point of it. Frame, then bezel at half weight, then
             the stand — `ri:computer-line`'s own three parts. -->
        <template v-else-if="kind === `mine`">
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

        <!-- RENTED, IN AN ACCOUNT OF THEIRS: a rack. Three units rather than one, because what separates this
             rung from the first is that the machine is a real server somebody is billed for. The vents sit at
             half weight and the status lights are solid — `ri:server-line`'s own arrangement. -->
        <template v-else>
            <g :class="edgeClass()" stroke="currentColor" :stroke-width="BAND">
                <rect x="24" y="5" width="84" height="19" rx="3" />
                <rect x="24" y="28.5" width="84" height="19" rx="3" />
                <rect x="24" y="52" width="84" height="19" rx="3" />
                <path d="M80 14.5h16M80 38h16M80 61.5h16" opacity="0.45" />
            </g>
            <g :class="popClass()" fill="currentColor">
                <rect x="34" y="12" width="5" height="5" rx="1.5" />
                <rect x="34" y="35.5" width="5" height="5" rx="1.5" />
                <rect x="34" y="59" width="5" height="5" rx="1.5" />
            </g>
        </template>
    </svg>
</template>
