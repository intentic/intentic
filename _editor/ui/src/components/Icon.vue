<!-- The single icon primitive for the whole app. Takes a stable semantic `name` and resolves it through the
     icon table (icons/iconSets.ts), via Iconify. Size/colour come from Tailwind classes on the tag
     (Iconify svg is 1em + currentColor), so `text-3xl`/`text-muted` etc. fall through exactly like the old
     <i class="pi …"> did. `spin` rotates through SVG's own animation element instead of a CSS animation:
     Chrome DevTools rebuilds the open Styles editor whenever request-driven CSS animations start or stop. -->
<script setup lang="ts">
import { Icon as IconifyIcon } from "@iconify/vue";
import { computed, onBeforeUnmount, onMounted, ref, useAttrs } from "vue";
import { ICONS, type IconName } from "../icons/iconSets.js";

const { name, spin = false } = defineProps<{ name: IconName; spin?: boolean }>();

/* AN ICON THAT WAS GIVEN A NAME IS NOT DECORATION, and this is the one line that makes that true.
 *
 * Iconify hides every glyph it draws (`aria-hidden: true` among its svg defaults) and clears that ONLY for a
 * caller who passes `aria-hidden` falsy — an `aria-label` does not do it. Which is the trap: the callers that
 * bothered to write a label are exactly the ones who meant the glyph to be read, and every one of them shipped
 * a labelled node that assistive tech skips. A silent no-op, on the accessibility affordance, reachable only by
 * doing the right thing.
 *
 * So the rule lives in the primitive rather than at each call site: a label (or a title) means announce me,
 * and `role="img"` — which Iconify already sets — makes the pair a properly named image. Unlabelled icons are
 * untouched and stay hidden, which is right for the overwhelming majority: they sit beside text that says the
 * same thing, and reading both is how a list of rows becomes twice as long to listen to.
 *
 * Both spellings are read because Vue hands a template's `aria-label` through as written while a bound object
 * may carry the camelCase form (Iconify's own switch checks both for the same reason). */
const attrs = useAttrs();
const named = computed(() => [`aria-label`, `ariaLabel`, `title`].some((key) => attrs[key] !== undefined && attrs[key] !== null));

const reducedMotion = ref(false);
let motionQuery: MediaQueryList | undefined;
const readMotionPreference = (): void => {
    reducedMotion.value = motionQuery?.matches === true;
};
onMounted(() => {
    if (typeof window.matchMedia !== `function`) {
        return;
    }
    motionQuery = window.matchMedia(`(prefers-reduced-motion: reduce)`);
    readMotionPreference();
    motionQuery.addEventListener(`change`, readMotionPreference);
});
onBeforeUnmount(() => motionQuery?.removeEventListener(`change`, readMotionPreference));

/* Remix is the one icon set and every glyph occupies a 24×24 view box (icons/iconSets.ts). SMIL stays outside
 * the CSS Animations model that makes DevTools replace its Styles rows, while still leaving a running mark for
 * work in progress. Reduced motion keeps the established slower, rather than frozen, spinner. */
const spinningBody = computed(
    () =>
        (body: string): string =>
            `<g>${body}<animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="${reducedMotion.value ? 3 : 1}s" repeatCount="indefinite" /></g>`,
);
</script>

<template>
    <!-- `undefined` rather than `true` for the unnamed case: not passing it leaves Iconify's own default in
         place, which is the same answer, and passing it would be this component racing its own library to
         say so. -->
    <IconifyIcon :icon="ICONS[name]" :customise="spin ? spinningBody : undefined" :aria-hidden="named ? false : undefined" class="ui-icon" />
</template>

<style scoped>
/* The svg is 1em×1em; inside a flex container (e.g. a PrimeVue button) the flex
   algorithm shrinks it on the main axis to a sliver, so it renders broken. Icons
   must always keep their intrinsic size regardless of flex pressure. */
svg {
    display: inline-block;
    vertical-align: -0.125em;
    flex: none;
}

/* Remix draws inside a smaller optical box than the other sets do, so its glyphs read a touch small beside
   text at the same font size. Unconditional now that Remix is the only set. */
.ui-icon {
    scale: 1.08;
    transform-origin: center;
}
</style>
