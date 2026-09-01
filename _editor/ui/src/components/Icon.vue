<!-- The single icon primitive for the whole app. Takes a stable semantic `name` and resolves it through the
     icon table (icons/iconSets.ts), via Iconify. Size/colour come from Tailwind classes on the tag
     (Iconify svg is 1em + currentColor), so `text-3xl`/`text-muted` etc. fall through exactly like the old
     <i class="pi …"> did. `spin` rotates through SVG's own animation element instead of a CSS animation:
     Chrome DevTools rebuilds the open Styles editor whenever request-driven CSS animations start or stop. -->
<script setup lang="ts">
import { Icon as IconifyIcon } from "@iconify/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ICONS, type IconName } from "../icons/iconSets.js";

const { name, spin = false } = defineProps<{ name: IconName; spin?: boolean }>();

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
    <IconifyIcon :icon="ICONS[name]" :customise="spin ? spinningBody : undefined" class="ui-icon" />
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
