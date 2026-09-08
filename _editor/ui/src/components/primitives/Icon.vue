<!--
    The single icon primitive for the app: resolves a stable semantic `name` through the icon table (icons/iconSets.ts) via Iconify. Size/colour come
    from Tailwind classes on the tag. `spin` animates via SVG's own element, not CSS, so DevTools' Styles panel doesn't rebuild every frame.
-->
<script setup lang="ts">
import { Icon as IconifyIcon } from "@iconify/vue";
import { computed, onBeforeUnmount, onMounted, ref, useAttrs } from "vue";
import { ICONS, type IconName } from "../../icons/iconSets.js";

const { name, spin = false } = defineProps<{ name: IconName; spin?: boolean }>();

// An `aria-label` or `title` clears Iconify's default `aria-hidden`, announcing the icon as a named
// image; unlabelled icons (most, sitting beside text) stay hidden.
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

/* Every glyph occupies a 24×24 view box (icons/iconSets.ts). SMIL stays outside
 * the CSS Animations model that makes DevTools replace its Styles rows, while still leaving a running mark for
 * work in progress. Reduced motion keeps the established slower, rather than frozen, spinner. */
const spinningBody = computed(
    () =>
        (body: string): string =>
            `<g>${body}<animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="${reducedMotion.value ? 3 : 1}s" repeatCount="indefinite" /></g>`,
);
</script>

<template>
    <!-- `undefined`, not `true`, for the unnamed case: leaves Iconify's own default rather than restating it. -->
    <IconifyIcon :icon="ICONS[name]" :customise="spin ? spinningBody : undefined" :aria-hidden="named ? false : undefined" class="ui-icon" />
</template>

<style scoped>
/*
 * The svg is 1em×1em; in a flex container it would otherwise shrink to a sliver, so keep its intrinsic
 * size regardless of flex pressure.
 */
svg {
    display: inline-block;
    vertical-align: -0.125em;
    flex: none;
}
</style>
