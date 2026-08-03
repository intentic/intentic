<!-- A THING, in a rounded square — what <Avatar> is for people, for everything that isn't one: a capability
     card, an extension in a list, a registry entry being read about before it is installed.

     THE LADDER IS THE WHOLE POINT, and it is the same argument <Avatar> makes one component over. Three tiers,
     because each of the top two is allowed to be absent and allowed to FAIL:

       logo   a simple-icons slug, fetched from a CDN. Right for anything standing in for somebody else's
              product, and wrong as a lone tier for three separate reasons: most things have no brand in that
              set, an offline sandbox reaches no CDN at all, and a renamed slug 404s long after the manifest
              declaring it was approved.
       icon   a name from the app's own vocabulary — bundled in the image, themed with the rest of the UI,
              no request. This is what actually carries a first-party extension. Also allowed to be a name
              this build has never heard of, since manifests are written against builds that haven't shipped.
       name   its initials. Always available, so the ladder can't bottom out in a hole.

     The copies this replaces disagreed at exactly the point that matters: two tracked failures in a reactive
     Set the CALLER had to own and never cleared, and two others (the automation source and recipe rows) had no
     error handler at all, so a dead slug left an empty box that reads as a rendering bug rather than as a
     thing. Here the tier underneath is already painted and the image sits OVER it, so a load that fails
     reveals the answer instead of a hole — no caller state, nothing to reset, and nothing to forget.

     DECORATIVE, always: the mark is `aria-hidden` and carries no label, because unlike an avatar in a stack it
     is never the only representation of the thing — every surface that draws one draws the name beside it, so a
     labelled mark makes a screen reader say every row twice. <Avatar> labels itself for the opposite reason.

     `idle` is for a thing that is present but switched off. It dims AND desaturates, which is the one treatment
     that works on all three tiers: a brand logo is full-colour and would otherwise keep shouting from a row
     whose every other element has gone quiet. -->
<script setup lang="ts">
import { computed } from "vue";
import { isIconName } from "../icons/iconSets.js";
import { initialsOf } from "../format.js";
import Icon from "./Icon.vue";

const {
    size,
    name,
    logo,
    icon,
    idle = false,
} = defineProps<{
    /** PIXELS, like <Avatar> and for the same reason: the sizes in use are 20, 22, 32 and 40, and snapping
     *  them to a scale would move four surfaces to make a prop look tidier. Everything inside tracks it. */
    size: number;
    /** The monogram tier — the one thing every caller can always supply. Not an accessible label: see below. */
    name: string;
    /** A simple-icons slug, optionally `<slug>/<hex>` to force a colour for a mark that would vanish. */
    logo?: string | undefined;
    /** A name from the app's icon set. An OPEN string: manifests declare it, so an unknown one is expected
     *  and falls to the monogram rather than drawing nothing. */
    icon?: string | undefined;
    /** Installed but switched off, listed but disabled — present, and not currently doing anything. */
    idle?: boolean;
}>();

const glyph = computed(() => (icon !== undefined && isIconName(icon) ? icon : undefined));
const initials = computed(() => initialsOf(name));

// The full CDN URL, built HERE so the app holds one copy of it. `?? undefined` is not needed: an absent slug
// simply never renders the <img>.
const logoUrl = computed(() => (logo === undefined ? undefined : `https://cdn.simpleicons.org/${logo}`));

// A dead slug degrades to the tier underneath. Hiding the element rather than clearing the URL keeps this a
// pure DOM effect — a re-render must not retry forever, and the caller's data is not ours to correct.
const hideBrokenImage = (event: Event): void => {
    (event.target as HTMLImageElement).style.display = `none`;
};
</script>

<template>
    <span
        class="relative flex shrink-0 items-center justify-center overflow-hidden border border-line bg-content/5 text-muted transition-opacity"
        :class="[idle ? `opacity-50 grayscale` : ``, size >= 28 ? `rounded-lg` : `rounded-md`]"
        :style="{ width: `${size}px`, height: `${size}px` }"
        aria-hidden="true"
    >
        <Icon v-if="glyph !== undefined" :name="glyph" :style="{ fontSize: `${size * 0.5}px` }" />
        <span v-else-if="initials !== undefined" class="font-semibold leading-none" :style="{ fontSize: `${Math.max(7, size * 0.375)}px` }">
            {{ initials }}
        </span>
        <!-- Over the fallback, never instead of it. no-referrer because an icon CDN has no business learning
             which sandbox is looking at it, nor which of its brands that sandbox has installed. -->
        <img
            v-if="logoUrl !== undefined"
            :src="logoUrl"
            alt=""
            referrerpolicy="no-referrer"
            class="absolute object-contain"
            :style="{ width: `${size * 0.625}px`, height: `${size * 0.625}px` }"
            @error="hideBrokenImage"
        />
    </span>
</template>
