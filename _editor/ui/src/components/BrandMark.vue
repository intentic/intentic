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
     thing. Here the tier underneath is painted first and the brand covers it only once its colour has really
     arrived, so a load that fails reveals the answer instead of a hole — no caller state, nothing to reset,
     nothing to forget. EXACTLY ONE TIER IS EVER ON SCREEN: a simple-icons mark is a transparent single-colour
     SVG, so a fallback left underneath a loaded one is read THROUGH it, and the elephant with a lightning bolt
     across it is not a fallback anybody recognises as one.

     DECORATIVE, always: the mark is `aria-hidden` and carries no label, because unlike an avatar in a stack it
     is never the only representation of the thing — every surface that draws one draws the name beside it, so a
     labelled mark makes a screen reader say every row twice. <Avatar> labels itself for the opposite reason.

     A BRAND MARK ARRIVES IN THE BRAND'S OWN COLOUR, and the one fetch pays for both halves of that: the CDN
     bakes each brand's official hex into the SVG it serves, so the document IS the colour source (no table of
     3000 brands to keep in step, and a slug invented next week is coloured correctly with no change here), and
     its text doubles as the mask that draws the shape. What makes the colour safe to honour — a brand hex is
     chosen to work on white, and this plate is white in one scheme and near-black in the other across four
     themes — is that each mark now brings its own OPAQUE plate, tinted with its own hue. brandColor.ts owns
     that reasoning and the arithmetic; brandMark.ts owns the fetch, and owns it from OUTSIDE this block because
     a `<script setup>` const is per-instance — so a cache kept here would let one screen fetch the same slug
     once per tile. Both schemes are resolved together into four custom properties and the mode picks between
     them in CSS, so flipping the theme repaints without a second fetch.

     `idle` is for a thing that is present but switched off. It drains the colour and dims — which is what makes
     a row go quiet, and now says the same thing to someone who cannot see the colour. -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { type Brand, brandUrl, loadBrand } from "./brandMark.js";
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
    /** A simple-icons slug. Colour is not the caller's to choose — the brand's own is what gets painted, and
     *  it comes from the fetched mark — so a `<slug>/<hex>` left over from when it was gets its colour
     *  dropped rather than passed on. */
    logo?: string | undefined;
    /** A name from the app's icon set. An OPEN string: manifests declare it, so an unknown one is expected
     *  and falls to the monogram rather than drawing nothing. */
    icon?: string | undefined;
    /** Installed but switched off, listed but disabled — present, and not currently doing anything. */
    idle?: boolean;
}>();

const glyph = computed(() => (icon !== undefined && isIconName(icon) ? icon : undefined));
const initials = computed(() => initialsOf(name));

// An absent slug simply never resolves a brand.
const logoUrl = computed(() => brandUrl(logo));

/* How far the top tier has got. Undefined means "not this tier" — still in flight, or answered with no brand —
 * and the tier underneath stays painted until a brand actually arrives. */
const brand = ref<Brand>();
watch(
    logoUrl,
    (url) => {
        // A mark can be re-pointed while mounted (a recycled list row). The new slug has its own load to do, so
        // the tier underneath comes back until it answers.
        brand.value = undefined;
        if (url === undefined) {
            return;
        }
        void loadBrand(url).then((resolved) => {
            // The row may have been re-pointed again while this was in flight; a late answer must not paint
            // over the slug that is current now.
            if (logoUrl.value === url) {
                brand.value = resolved;
            }
        });
    },
    { immediate: true },
);
</script>

<template>
    <span
        class="relative flex shrink-0 items-center justify-center overflow-hidden border border-line transition-opacity"
        :class="[
            idle ? `opacity-50 grayscale` : ``,
            size >= 28 ? `rounded-lg` : `rounded-md`,
            // The brand's own plate replaces the neutral one only once its colour is known — a tinted tile
            // under a fallback glyph would claim a brand that never loaded.
            brand === undefined ? `bg-content/5 text-muted` : `brand-plate`,
        ]"
        :style="{
            width: `${size}px`,
            height: `${size}px`,
            ...(brand === undefined
                ? {}
                : {
                      // Declared once here and inherited by the mark below. Both schemes, because which one is
                      // wanted is a fact about the page, not about the brand — the CSS at the foot picks.
                      '--brand-plate-light': brand.palette.plateLight,
                      '--brand-plate-dark': brand.palette.plateDark,
                      '--brand-mark-light': brand.palette.markLight,
                      '--brand-mark-dark': brand.palette.markDark,
                  }),
        }"
        aria-hidden="true"
    >
        <template v-if="brand === undefined">
            <Icon v-if="glyph !== undefined" :name="glyph" :style="{ fontSize: `${size * 0.5}px` }" />
            <span v-else-if="initials !== undefined" class="font-semibold leading-none" :style="{ fontSize: `${Math.max(7, size * 0.375)}px` }">
                {{ initials }}
            </span>
        </template>
        <!-- The mark itself: the fetched SVG as a MASK over the brand's colour. A mask rather than the image,
             because the colour that ships is the one brandColor.ts cleared against this plate, not whatever
             the file happens to carry. -->
        <span
            v-else
            class="brand-mark absolute"
            :style="{
                width: `${size * 0.625}px`,
                height: `${size * 0.625}px`,
                // Prefixed as well as not: unprefixed `mask` is recent in Safari, and where it is not understood
                // the element keeps its background and paints a filled square — the one failure here that looks
                // like a bug rather than like a fallback.
                WebkitMaskImage: brand.mask,
                WebkitMaskSize: `contain`,
                WebkitMaskPosition: `center`,
                WebkitMaskRepeat: `no-repeat`,
                maskImage: brand.mask,
                maskSize: `contain`,
                maskPosition: `center`,
                maskRepeat: `no-repeat`,
            }"
        />
    </span>
</template>

<!-- Which scheme's pair to paint. Keyed off the app's [data-mode] exactly as the code blocks' Shiki colours
     are, so a theme flip is a repaint of two properties rather than 35 fetches — and no `!important` is needed
     here, because what the element carries inline is the custom properties, never the colour itself. -->
<style scoped>
.brand-plate {
    background-color: var(--brand-plate-light);
}
.brand-mark {
    background-color: var(--brand-mark-light);
}
[data-mode="dark"] .brand-plate {
    background-color: var(--brand-plate-dark);
}
[data-mode="dark"] .brand-mark {
    background-color: var(--brand-mark-dark);
}
</style>
