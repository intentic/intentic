<!-- A loading placeholder drawn exactly as its content last looked (the imprint `v-skeleton-source` took under the same name), and the slot's hand-drawn one until there is an imprint to draw. -->
<script setup lang="ts">
import { computed } from "vue";
import { SkeletonGhost } from "../../lib/skeletonGhost.js";
import { imprintOf } from "../../lib/skeletonStore.js";

defineOptions({ inheritAttrs: false });

const { of, label } = defineProps<{
    /**
     * The name the content's `v-skeleton-source` records under; scoped to the sandbox by the store. Carry a variant
     * when the content differs by it (`diff:${path}`), never one that changes on every visit.
     */
    of: string;
    /**
     * What a screen reader hears while the remembered shape stands in. The slot's fallback carries its own status
     * region, so this is only for the ghost; leave it unset where an enclosing element already announces the wait.
     */
    label?: string;
}>();

const imprint = computed(() => imprintOf(of));
</script>

<template>
    <SkeletonGhost v-if="imprint !== undefined" :imprint="imprint" :label="label" />
    <slot v-else />
</template>
