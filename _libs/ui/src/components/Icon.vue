<!-- The single icon primitive for the whole app. Takes a stable semantic `name` and resolves it through the
     icon table (icons/iconSets.ts), via Iconify. Size/colour come from Tailwind classes on the tag
     (Iconify svg is 1em + currentColor), so `text-3xl`/`text-muted` etc. fall through exactly like the old
     <i class="pi …"> did. `spin` adds the loading animation (replaces the old `pi-spin` modifier). -->
<script setup lang="ts">
import { Icon as IconifyIcon } from "@iconify/vue";
import { ICONS, type IconName } from "../icons/iconSets.js";

const { name, spin = false } = defineProps<{ name: IconName; spin?: boolean }>();
</script>

<template>
    <IconifyIcon :icon="ICONS[name]" :class="{ 'animate-spin': spin }" class="ui-icon" />
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
