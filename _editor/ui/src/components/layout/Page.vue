<!--
    Centered, width-constrained page shell. `width` selects the max-width tier (`content`, `wide`, `full`) via a data attribute resolved in the
    stylesheet, so extension bundles get the right width without Tailwind scanning them.
-->
<script setup lang="ts">
withDefaults(defineProps<{ width?: `content` | `wide` | `full` }>(), { width: `content` });
</script>

<template>
    <div class="ui-page" :data-width="width">
        <slot />
    </div>
</template>
