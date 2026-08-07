<!-- A THING, in a rounded square — what <Avatar> is for people, for everything that isn't one: a capability
     card, an extension in a list, a registry entry being read about before it is installed.

     THE LADDER IS THE WHOLE POINT, and it is the same argument <Avatar> makes one component over. Three tiers,
     because each of the top two is allowed to be absent and allowed to FAIL:

       logo   a simple-icons slug, fetched from a CDN. Right for anything standing in for somebody else's
              product, and wrong as a lone tier for three separate reasons: most things have no brand in that
              set (Slack is not in it at all), an offline sandbox reaches no CDN at all, and a renamed slug
              404s long after the manifest declaring it was approved.
       icon   a name from the app's own vocabulary — bundled in the image, themed with the rest of the UI,
              no request. This is what actually carries a first-party extension. Also allowed to be a name
              this build has never heard of, since manifests are written against builds that haven't shipped.
       name   its initials. Always available, so the ladder can't bottom out in a hole.

     The copies this replaces disagreed at exactly the point that matters: two tracked failures in a reactive
     Set the CALLER had to own and never cleared, and two others (the automation source and recipe rows) had no
     error handler at all, so a dead slug left an empty box that reads as a rendering bug rather than as a
     thing. Here the tier underneath is painted first and the image covers it only once it has really loaded,
     so a load that fails reveals the answer instead of a hole — no caller state, nothing to reset, nothing to
     forget. EXACTLY ONE TIER IS EVER ON SCREEN: a simple-icons mark is a transparent single-colour SVG, so a
     fallback left underneath a loaded one is read THROUGH it, and the elephant with a lightning bolt across it
     is not a fallback anybody recognises as one.

     DECORATIVE, always: the mark is `aria-hidden` and carries no label, because unlike an avatar in a stack it
     is never the only representation of the thing — every surface that draws one draws the name beside it, so a
     labelled mark makes a screen reader say every row twice. <Avatar> labels itself for the opposite reason.

     EVERY TIER IS DRAWN IN THE THEME'S OWN TEXT COLOUR, brand marks included. A brand's colour is chosen to
     work on white, and this plate is white in one scheme and near-black in the other across four themes — so
     honouring it meant 13 of 20 marks landing under 3:1 on the dark card (Sentry at 1.05:1 is not visible at
     all), and the four manifests that noticed pinned themselves to near-white, which is the same bug pointed at
     the light scheme. Nobody could have got this right by hand: it is a fact about the surface, which the
     manifest declaring a slug cannot see. So the slug names WHICH mark and nothing else, any colour in it is
     ignored, and the mark is painted as a mask filled with `currentColor` — this plate's own text colour, the
     very one the glyph tier already uses, in every theme, with no second request when the scheme flips. All
     three tiers therefore weigh the same on a row, which is the other half of what was wrong: a full-colour
     logo beside a muted glyph read as two different kinds of thing.

     `idle` is for a thing that is present but switched off. It dims: with every tier monochrome there is no
     longer any colour to drain, and dimming is what makes a row go quiet. -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
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
    /** PIXELS, like <Avatar> and for the same reason: the sizes in use are 20, 22, 24, 32 and 40, and snapping
     *  them to a scale would move five surfaces to make a prop look tidier. Everything inside tracks it. */
    size: number;
    /** The monogram tier — the one thing every caller can always supply. Not an accessible label: see below. */
    name: string;
    /** A simple-icons slug. Colour is not the caller's to choose (see above), so a `<slug>/<hex>` left over
     *  from when it was gets its colour dropped rather than passed on — appended to ours the CDN reads it as
     *  the light half of a light/dark pair, and the mark comes out wrong in exactly one scheme. */
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
// simply never renders the <img>. One URL for every scheme — the colour is applied in CSS, so flipping the
// theme repaints rather than re-fetching, and the mark never blinks back to its fallback to do it.
const logoUrl = computed(() => (logo === undefined ? undefined : `https://cdn.simpleicons.org/${logo.split(`/`)[0]}`));

// How far the top tier has got. The image is allowed to fail, so the tier under it stays painted until the
// load actually succeeds — but only until then: a simple-icons mark is a transparent single-colour SVG, so a
// glyph left underneath one shows through its holes and reads as a deformed logo rather than as a fallback.
// `failed` also stops the retry a re-render would otherwise mount, and the caller's slug is not ours to correct.
const logoState = ref<`pending` | `loaded` | `failed`>(`pending`);
// A mark can be re-pointed while mounted (a recycled list row). The new slug has its own load to do, so the
// tier underneath comes back until it answers.
watch(logoUrl, () => {
    logoState.value = `pending`;
});
</script>

<template>
    <span
        class="relative flex shrink-0 items-center justify-center overflow-hidden border border-line bg-content/5 text-muted transition-opacity"
        :class="[idle ? `opacity-50` : ``, size >= 28 ? `rounded-lg` : `rounded-md`]"
        :style="{ width: `${size}px`, height: `${size}px` }"
        aria-hidden="true"
    >
        <template v-if="logoState !== `loaded`">
            <Icon v-if="glyph !== undefined" :name="glyph" :style="{ fontSize: `${size * 0.5}px` }" />
            <span v-else-if="initials !== undefined" class="font-semibold leading-none" :style="{ fontSize: `${Math.max(7, size * 0.375)}px` }">
                {{ initials }}
            </span>
        </template>
        <!-- THE LOAD PROBE, and only that: it is the element that knows whether the slug resolved, which is
             what the ladder turns on, and it is never seen. Its src is the same URL the mask below paints, so
             the two share one fetch. no-referrer because an icon CDN has no business learning which sandbox is
             looking at it, nor which of its brands that sandbox has installed. -->
        <img
            v-if="logoUrl !== undefined && logoState !== `failed`"
            :src="logoUrl"
            alt=""
            referrerpolicy="no-referrer"
            class="absolute size-0 opacity-0"
            @load="logoState = `loaded`"
            @error="logoState = `failed`"
        />
        <!-- The mark itself: the fetched SVG used as a MASK over the current text colour, so it is themed like
             every other tier rather than arriving in a brand's own palette. Only once the probe has answered —
             a mask that 404s paints a filled square, which is worse than the fallback it would be covering. -->
        <span
            v-if="logoUrl !== undefined && logoState === `loaded`"
            class="absolute bg-current"
            :style="{
                width: `${size * 0.625}px`,
                height: `${size * 0.625}px`,
                // Prefixed as well as not: unprefixed `mask` is recent in Safari, and where it is not understood
                // the element keeps its background and paints a filled square — the one failure here that looks
                // like a bug rather than like a fallback.
                WebkitMaskImage: `url(${logoUrl})`,
                WebkitMaskSize: `contain`,
                WebkitMaskPosition: `center`,
                WebkitMaskRepeat: `no-repeat`,
                maskImage: `url(${logoUrl})`,
                maskSize: `contain`,
                maskPosition: `center`,
                maskRepeat: `no-repeat`,
            }"
        />
    </span>
</template>
