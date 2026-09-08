<!--
    A thing, in a rounded square: <Avatar>'s counterpart for non-people (capabilities, extensions, registry entries). Fallback ladder: inline SVG
    art, then a simple-icons logo, then a bundled icon, then initials. Art renders via `<img>`, never inlined or v-html, so a hostile SVG cannot
    script the page.
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { artSrc, type Brand, brandUrl, loadBrand } from "./brandMark.js";
import { isIconName } from "../../icons/iconSets.js";
import { initialsOf } from "../../lib/format.js";
import Icon from "../primitives/Icon.vue";

const {
    size,
    name,
    art,
    logo,
    icon,
    idle = false,
    flush = false,
} = defineProps<{
    /** Pixels, like <Avatar>; under `flush` the box is the container's, and this only scales what's inside it. */
    size: number;
    /** The monogram tier: the one thing every caller can always supply. Not an accessible label. */
    name: string;
    /** The thing's own mark as a complete SVG document; anything not a drawable document falls to the tier below. */
    art?: string | undefined;
    /** A simple-icons slug; colour comes from the fetched brand, so a leftover `<slug>/<hex>` has its hex dropped. */
    logo?: string | undefined;
    /** A name from the app's icon set; an unknown one is expected and falls to the monogram, not a blank. */
    icon?: string | undefined;
    /** Installed but switched off, listed but disabled: present, and not currently doing anything. */
    idle?: boolean;
    /** A band filling one edge, not a badge on the container: no rounding, no border, stretched to fit. */
    flush?: boolean;
}>();

const drawing = computed(() => artSrc(art));
const glyph = computed(() => (icon !== undefined && isIconName(icon) ? icon : undefined));
const initials = computed(() => initialsOf(name));

// Skips the fetch once art has won, so an unpainted mark doesn't still tell a CDN who's looking.
const logoUrl = computed(() => (drawing.value === undefined ? brandUrl(logo) : undefined));

// Undefined means not-this-tier (in flight or no brand); the tier underneath stays painted until one arrives.
const brand = ref<Brand>();
watch(
    logoUrl,
    (url) => {
        // A recycled row can re-point mid-mount; the tier underneath returns until the new slug's load answers.
        brand.value = undefined;
        if (url === undefined) {
            return;
        }
        void loadBrand(url).then((resolved) => {
            // Guards a re-point mid-flight: a late answer must not paint over the slug that's current now.
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
        class="relative flex shrink-0 items-center justify-center overflow-hidden transition-opacity"
        :class="[
            idle ? `opacity-50 grayscale` : ``,
            // Both belong to the badge shape only: a flush mark is inside a border that is already drawn.
            flush ? `` : [`border border-line`, size >= 28 ? `rounded-lg` : `rounded-md`],
            /* Two independent questions, and they stay independent: `flush` decides the OUTLINE (whose border
             * and whose corners), artwork decides the PLATE (whether there is anything to paint under the
             * mark). A drawing brings its own square, so it gets no plate in either shape: see the note above.
             * Otherwise the brand's own plate replaces the neutral one only once its colour is known: a tinted
             * tile under a fallback glyph would claim a brand that never loaded. */
            drawing !== undefined ? `` : brand === undefined ? `bg-content/5 text-muted` : `brand-plate`,
        ]"
        :style="{
            // Stretched to the container and held square, rather than sized here: the height belongs to
            // whatever sits beside it, and that is in rem, so a pixel written here would be right at one
            // browser font size and wrong at every other.
            ...(flush ? { width: `auto`, height: `auto`, aspectRatio: `1` } : { width: `${size}px`, height: `${size}px` }),
            ...(brand === undefined
                ? {}
                : {
                      // Declared once here and inherited by the mark below. Both schemes, because which one is
                      // wanted is a fact about the page, not about the brand: the CSS at the foot picks.
                      '--brand-plate-light': brand.palette.plateLight,
                      '--brand-plate-dark': brand.palette.plateDark,
                      '--brand-mark-light': brand.palette.markLight,
                      '--brand-mark-dark': brand.palette.markDark,
                  }),
        }"
        aria-hidden="true"
    >
        <!--
            `object-cover`, not `contain`: this is a tile, not a framed picture, so it should meet the rounded corners
            like
            an app icon. Decorative (empty alt), since the name is always drawn beside it.
        -->
        <img v-if="drawing !== undefined" :src="drawing" alt="" class="h-full w-full object-cover" draggable="false" />
        <template v-else-if="brand === undefined">
            <Icon v-if="glyph !== undefined" :name="glyph" :style="{ fontSize: `${size * 0.5}px` }" />
            <span v-else-if="initials !== undefined" class="font-semibold leading-none" :style="{ fontSize: `${Math.max(7, size * 0.375)}px` }">
                {{ initials }}
            </span>
        </template>
        <!--
            Masks the fetched SVG over the brand's colour, rather than showing the image, since brandColor.ts's cleared
            colour is what should paint, not the file's own.
        -->
        <span
            v-else
            class="brand-mark absolute"
            :style="{
                width: `${size * 0.625}px`,
                height: `${size * 0.625}px`,
                // Prefixed as well as not: unprefixed `mask` is recent in Safari, and where it is not understood
                // the element keeps its background and paints a filled square: the one failure here that looks
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

<!--
    Colours key off `[data-mode]`, the same switch as Shiki's code-block colours, so a theme flip repaints two custom properties instead of
    refetching. The element carries only custom properties inline, never the colour, so no `!important` is needed here.
-->
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
