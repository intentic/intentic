<!-- Centered, width-constrained page shell. Replaces the repeated `mx-auto max-w-* p-6` wrappers; padding
     comes from the `--ui-page-*` tokens via the `.ui-page` class, and `width` selects the max-width tier:
     `content` (reading / forms, the default), `wide` (dense data-list panels), or `full` (canvas surfaces
     that need every pixel). The tier is a data attribute resolved in the design-system stylesheet, so
     extension bundles — which Tailwind's `@source` globs don't scan — still get the right width without
     depending on a utility class being generated. -->
<script setup lang="ts">
withDefaults(defineProps<{ width?: `content` | `wide` | `full` }>(), { width: `content` });
</script>

<template>
    <div class="ui-page" :data-width="width">
        <slot />
    </div>
</template>
