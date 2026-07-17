<!-- The single icon primitive for the whole app. Takes a stable semantic `name` and renders it in whatever
     set the user has picked (useIconSet), via Iconify. Size/colour come from Tailwind classes on the tag
     (Iconify svg is 1em + currentColor), so `text-3xl`/`text-muted` etc. fall through exactly like the old
     <i class="pi …"> did. `spin` adds the loading animation (replaces the old `pi-spin` modifier). -->
<script setup lang="ts">
import { Icon as IconifyIcon } from "@iconify/vue";
import { computed } from "vue";
import { ICON_SETS, type IconName } from "../icons/iconSets.js";
import { useIconSet } from "../composables/useIconSet.js";

const { name, spin = false } = defineProps<{ name: IconName; spin?: boolean }>();

const { iconSet } = useIconSet();
const icon = computed(() => ICON_SETS[iconSet.value][name]);
const iconClass = computed(() => ({
    "animate-spin": spin,
    "ui-icon--remix": iconSet.value === `remix`,
}));
</script>

<template>
    <IconifyIcon :icon="icon" :class="iconClass" />
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

.ui-icon--remix {
    scale: 1.08;
    transform-origin: center;
}
</style>
