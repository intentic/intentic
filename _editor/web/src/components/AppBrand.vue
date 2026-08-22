<!-- THE PRODUCT'S OWN MARK, AND THE ONE PLACE IT IS DRAWN. The lotus and the word beside it, identical to the
     drawing the marketing pages carry (site: src/components/Lotus.astro and the `.brand` block in Nav.astro),
     so the page somebody signs in on is visibly the page they just came from.

     IT REPLACES A PNG WORDMARK THAT WAS TWO BRANDS AGO. Every entry screen in the app — sign in, join, accept
     an invite, connect a machine, approve a run, first-run setup, desktop auth — carried the same orange
     letterform bitmap, filed under eight different call sites, so correcting the brand meant finding all eight.
     One component instead: the mark is drawn, not fetched, so it takes the page's own colour, stays sharp at
     any size and on any screen, and costs no request on the one page a visitor waits on.

     TWO SHAPES, because the entry pages need both and they are the same object: `lockup` is mark plus word and
     is what a page leads with; `mark` is the flower alone, for a row that already says the name in text.

     THE WORD IS SET IN THE BRAND FACE with the app's sans behind it, and it is deliberately NOT given the
     site's glow: a marketing header is looked at, a sign-in form is worked through, and a lit wordmark over a
     form pulls the eye away from the field the page exists to collect. -->
<script setup lang="ts">
withDefaults(
    defineProps<{
        /** `lockup` draws the flower and the word; `mark` draws the flower alone. */
        shape?: "lockup" | "mark";
    }>(),
    { shape: `lockup` },
);
</script>

<template>
    <!-- `primary-500` rather than a fixed hex: the site's mark is one orange because a site has one brand
         colour, and this app lets a person pick theirs — a logo that ignored the pick would be the one object
         on the screen still wearing the default. On the sign-in pages, which is where this is mostly met,
         nobody has picked anything yet, so it comes out as the brand's own orange. -->
    <span class="inline-flex items-center gap-2.5 text-primary-500" aria-label="intentic">
        <!-- `-1.3` on the viewBox's y is the site's own framing: the drawing sits low in its square, and the
             offset is what centres the flower's ink rather than its bounding box. -->
        <svg class="brand-lotus" viewBox="0 -1.3 32 32" fill="currentColor" aria-hidden="true">
            <path d="M8.4 25.6c-3.2 0-5.6-1-7.2-3 3.6-1.2 6.6-.7 9 1.4z" opacity=".42" />
            <path d="M23.6 25.6c3.2 0 5.6-1 7.2-3-3.6-1.2-6.6-.7-9 1.4z" opacity=".42" />
            <path
                d="M16 9.5c2.1 3 3.2 5.7 3.2 8.1 0 2.2-1.1 4.1-3.2 5.6-2.1-1.5-3.2-3.4-3.2-5.6 0-2.4 1.1-5.1 3.2-8.1z"
                transform="rotate(-74 16 22.6)"
                opacity=".55"
            />
            <path
                d="M16 9.5c2.1 3 3.2 5.7 3.2 8.1 0 2.2-1.1 4.1-3.2 5.6-2.1-1.5-3.2-3.4-3.2-5.6 0-2.4 1.1-5.1 3.2-8.1z"
                transform="rotate(74 16 22.6)"
                opacity=".55"
            />
            <path
                d="M16 6.4c2.4 3.4 3.6 6.4 3.6 9.1 0 2.5-1.2 4.6-3.6 6.3-2.4-1.7-3.6-3.8-3.6-6.3 0-2.7 1.2-5.7 3.6-9.1z"
                transform="rotate(-39 16 21.7)"
                opacity=".78"
            />
            <path
                d="M16 6.4c2.4 3.4 3.6 6.4 3.6 9.1 0 2.5-1.2 4.6-3.6 6.3-2.4-1.7-3.6-3.8-3.6-6.3 0-2.7 1.2-5.7 3.6-9.1z"
                transform="rotate(39 16 21.7)"
                opacity=".78"
            />
            <path d="M16 3.4c2.8 4 4.2 7.5 4.2 10.6 0 2.9-1.4 5.4-4.2 7.3-2.8-1.9-4.2-4.4-4.2-7.3 0-3.1 1.4-6.6 4.2-10.6z" />
        </svg>
        <!-- The flower's square reserves room for descenders the word "intentic" does not have, so centring the
             two BOXES parks the mark visibly above the letters. The nudge is the site's, in the same direction
             and for the same reason. -->
        <span v-if="shape === `lockup`" class="brand-word">intentic</span>
    </span>
</template>

<style scoped>
.brand-lotus {
    width: 1.15em;
    height: 1.15em;
    flex: none;
    transform: translateY(-0.05em);
}
.brand-word {
    font-family: "Baloo 2", ui-rounded, var(--font-sans);
    font-size: 1.5em;
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0.005em;
}
</style>
